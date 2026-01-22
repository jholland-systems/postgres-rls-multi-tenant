import { z } from 'zod';

/**
 * Common validation schemas using Zod
 *
 * These schemas provide type-safe request validation and automatic error messages.
 */

// UUID schema (reusable)
export const uuidSchema = z.string().uuid('Invalid UUID format');

// Pagination schema
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

// User schemas
export const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().min(1, 'Name is required').max(255),
  role: z.enum(['member', 'admin', 'owner']).default('member'),
});

export const updateUserSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  name: z.string().min(1).max(255).optional(),
  role: z.enum(['member', 'admin', 'owner']).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// Project schemas
export const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(255),
  description: z.string().max(1000).optional(),
  status: z.enum(['active', 'archived', 'completed']).default('active'),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['active', 'archived', 'completed']).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// Task schemas
export const createTaskSchema = z.object({
  project_id: uuidSchema,
  title: z.string().min(1, 'Task title is required').max(255),
  description: z.string().max(1000).optional(),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'blocked'])
    .default('pending'),
  assigned_to: uuidSchema.nullable().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
  assigned_to: uuidSchema.nullable().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// Tenant schemas
export const createTenantSchema = z.object({
  name: z.string().min(1, 'Tenant name is required').max(255),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Invalid slug format (lowercase alphanumeric and hyphens)')
    .min(2)
    .max(63),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .min(2)
    .max(63)
    .optional(),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/**
 * Validation middleware factory
 *
 * Creates Express middleware that validates request body against a Zod schema.
 *
 * Usage:
 * ```typescript
 * app.post('/api/projects',
 *   requireTenantContext,
 *   validate(createProjectSchema),
 *   asyncHandler(async (req, res) => {
 *     // req.body is now typed and validated
 *     const project = await createProject(req.body);
 *     res.json(project);
 *   })
 * );
 * ```
 */
export function validate<T extends z.ZodTypeAny>(schema: T) {
  return (req: any, res: any, next: any) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
          correlationId: req.correlationId,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Query parameter validation helper
 *
 * Validates query parameters (e.g., pagination, filters).
 *
 * Usage:
 * ```typescript
 * app.get('/api/projects',
 *   validateQuery(paginationSchema),
 *   asyncHandler(async (req, res) => {
 *     const { page, limit } = req.query;
 *     // page and limit are now validated and typed
 *   })
 * );
 * ```
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: any, res: any, next: any) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Invalid query parameters',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
          correlationId: req.correlationId,
        });
        return;
      }
      next(error);
    }
  };
}
