import { Router } from 'express';
import { withTenantContext } from '../database/client.js';
import {
  requireTenantContext,
  asyncHandler,
  NotFoundError,
} from '../middleware/index.js';
import {
  validate,
  validateQuery,
  createProjectSchema,
  updateProjectSchema,
  paginationSchema,
  uuidSchema,
} from '../utils/validation.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Projects routes (tenant-scoped)
 *
 * All routes use requireTenantContext middleware to ensure tenant context is present.
 * All database queries use withTenantContext() which sets SET LOCAL app.current_tenant_id.
 * RLS policies automatically filter results to the current tenant.
 *
 * This demonstrates the core tenant isolation pattern:
 * 1. Middleware extracts tenant ID from request
 * 2. requireTenantContext ensures it's present (401 if missing)
 * 3. withTenantContext sets database context
 * 4. RLS policies enforce isolation
 */

// Apply tenant context requirement to all routes
router.use(requireTenantContext);

// GET /api/projects - List projects for current tenant
router.get(
  '/',
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const offset = (page - 1) * limit;

    const projects = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('projects')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();
    });

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        count: projects.length,
        page,
        limit,
      },
      'Listed projects for tenant'
    );

    res.json({
      projects,
      count: projects.length,
      page,
      limit,
      correlationId: req.correlationId,
    });
  })
);

// GET /api/projects/:id - Get project by ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const projectId = uuidSchema.parse(req.params.id);

    const project = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', projectId)
        .executeTakeFirst();
    });

    if (!project) {
      throw new NotFoundError('Project');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        projectId: project.id,
      },
      'Retrieved project'
    );

    res.json({
      project,
      correlationId: req.correlationId,
    });
  })
);

// POST /api/projects - Create new project
router.post(
  '/',
  validate(createProjectSchema),
  asyncHandler(async (req, res) => {
    const project = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .insertInto('projects')
        .values({
          ...req.body,
          tenant_id: req.tenantId!, // Explicitly set tenant_id
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        projectId: project.id,
      },
      'Created new project'
    );

    res.status(201).json({
      project,
      correlationId: req.correlationId,
    });
  })
);

// PATCH /api/projects/:id - Update project
router.patch(
  '/:id',
  validate(updateProjectSchema),
  asyncHandler(async (req, res) => {
    const projectId = uuidSchema.parse(req.params.id);

    const project = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .updateTable('projects')
        .set(req.body)
        .where('id', '=', projectId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!project) {
      throw new NotFoundError('Project');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        projectId: project.id,
      },
      'Updated project'
    );

    res.json({
      project,
      correlationId: req.correlationId,
    });
  })
);

// DELETE /api/projects/:id - Delete project
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const projectId = uuidSchema.parse(req.params.id);

    const deleted = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .deleteFrom('projects')
        .where('id', '=', projectId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!deleted) {
      throw new NotFoundError('Project');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        projectId: deleted.id,
      },
      'Deleted project (CASCADE will remove related tasks)'
    );

    res.json({
      message: 'Project deleted successfully',
      project: deleted,
      correlationId: req.correlationId,
    });
  })
);

export default router;
