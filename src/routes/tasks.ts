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
  createTaskSchema,
  updateTaskSchema,
  paginationSchema,
  uuidSchema,
} from '../utils/validation.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Tasks routes (tenant-scoped)
 *
 * All routes use requireTenantContext middleware to ensure tenant context is present.
 * All database queries use withTenantContext() which sets SET LOCAL app.current_tenant_id.
 * RLS policies automatically filter results to the current tenant.
 *
 * Tasks demonstrate composite foreign keys:
 * - (tenant_id, project_id) → projects(tenant_id, id)
 * - (tenant_id, assigned_to) → users(tenant_id, id)
 *
 * These composite FKs enforce tenant boundaries at the constraint level,
 * providing defense-in-depth beyond RLS.
 */

// Apply tenant context requirement to all routes
router.use(requireTenantContext);

// GET /api/tasks - List tasks for current tenant
router.get(
  '/',
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const offset = (page - 1) * limit;

    const tasks = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('tasks')
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
        count: tasks.length,
        page,
        limit,
      },
      'Listed tasks for tenant'
    );

    res.json({
      tasks,
      count: tasks.length,
      page,
      limit,
      correlationId: req.correlationId,
    });
  })
);

// GET /api/tasks/:id - Get task by ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const taskId = uuidSchema.parse(req.params.id);

    const task = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', taskId)
        .executeTakeFirst();
    });

    if (!task) {
      throw new NotFoundError('Task');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        taskId: task.id,
      },
      'Retrieved task'
    );

    res.json({
      task,
      correlationId: req.correlationId,
    });
  })
);

// POST /api/tasks - Create new task
router.post(
  '/',
  validate(createTaskSchema),
  asyncHandler(async (req, res) => {
    const task = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .insertInto('tasks')
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
        taskId: task.id,
        projectId: task.project_id,
      },
      'Created new task'
    );

    res.status(201).json({
      task,
      correlationId: req.correlationId,
    });
  })
);

// PATCH /api/tasks/:id - Update task
router.patch(
  '/:id',
  validate(updateTaskSchema),
  asyncHandler(async (req, res) => {
    const taskId = uuidSchema.parse(req.params.id);

    const task = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .updateTable('tasks')
        .set(req.body)
        .where('id', '=', taskId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!task) {
      throw new NotFoundError('Task');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        taskId: task.id,
      },
      'Updated task'
    );

    res.json({
      task,
      correlationId: req.correlationId,
    });
  })
);

// DELETE /api/tasks/:id - Delete task
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const taskId = uuidSchema.parse(req.params.id);

    const deleted = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .deleteFrom('tasks')
        .where('id', '=', taskId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!deleted) {
      throw new NotFoundError('Task');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        taskId: deleted.id,
      },
      'Deleted task'
    );

    res.json({
      message: 'Task deleted successfully',
      task: deleted,
      correlationId: req.correlationId,
    });
  })
);

export default router;
