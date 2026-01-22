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
  createUserSchema,
  updateUserSchema,
  paginationSchema,
  uuidSchema,
} from '../utils/validation.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Users routes (tenant-scoped)
 *
 * All routes use requireTenantContext middleware to ensure tenant context is present.
 * All database queries use withTenantContext() which sets SET LOCAL app.current_tenant_id.
 * RLS policies automatically filter results to the current tenant.
 *
 * Users table demonstrates:
 * - CITEXT for case-insensitive email matching
 * - UNIQUE(tenant_id, email) constraint (prevents duplicates within tenant)
 * - Role-based access control (member, admin, owner)
 */

// Apply tenant context requirement to all routes
router.use(requireTenantContext);

// GET /api/users - List users for current tenant
router.get(
  '/',
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const offset = (page - 1) * limit;

    const users = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('users')
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
        count: users.length,
        page,
        limit,
      },
      'Listed users for tenant'
    );

    res.json({
      users,
      count: users.length,
      page,
      limit,
      correlationId: req.correlationId,
    });
  })
);

// GET /api/users/:id - Get user by ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = uuidSchema.parse(req.params.id);

    const user = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirst();
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        userId: user.id,
      },
      'Retrieved user'
    );

    res.json({
      user,
      correlationId: req.correlationId,
    });
  })
);

// POST /api/users - Create new user
router.post(
  '/',
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const user = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .insertInto('users')
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
        userId: user.id,
        email: user.email,
      },
      'Created new user'
    );

    res.status(201).json({
      user,
      correlationId: req.correlationId,
    });
  })
);

// PATCH /api/users/:id - Update user
router.patch(
  '/:id',
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const userId = uuidSchema.parse(req.params.id);

    const user = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .updateTable('users')
        .set(req.body)
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        userId: user.id,
      },
      'Updated user'
    );

    res.json({
      user,
      correlationId: req.correlationId,
    });
  })
);

// DELETE /api/users/:id - Delete user
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = uuidSchema.parse(req.params.id);

    const deleted = await withTenantContext(req.tenantId!, async (tx) => {
      return await tx
        .deleteFrom('users')
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!deleted) {
      throw new NotFoundError('User');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: req.tenantId,
        userId: deleted.id,
      },
      'Deleted user (SET NULL on assigned tasks)'
    );

    res.json({
      message: 'User deleted successfully',
      user: deleted,
      correlationId: req.correlationId,
    });
  })
);

export default router;
