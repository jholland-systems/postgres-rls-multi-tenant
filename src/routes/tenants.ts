import { Router } from 'express';
import { withSystemContext } from '../database/client.js';
import { asyncHandler } from '../middleware/error-handler.js';
import {
  validate,
  createTenantSchema,
  updateTenantSchema,
  uuidSchema,
} from '../utils/validation.js';
import { NotFoundError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Tenant routes (system-level)
 *
 * These routes use withSystemContext() because the tenants table itself
 * has NO RLS - it's the root of the tenant hierarchy.
 *
 * In production, these routes would be protected by admin authentication.
 */

// GET /api/tenants - List all tenants
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tenants = await withSystemContext(async (db) => {
      return await db
        .selectFrom('tenants')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();
    });

    logger.info(
      {
        correlationId: req.correlationId,
        count: tenants.length,
      },
      'Listed all tenants'
    );

    res.json({
      tenants,
      count: tenants.length,
      correlationId: req.correlationId,
    });
  })
);

// GET /api/tenants/:id - Get tenant by ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tenantId = uuidSchema.parse(req.params.id);

    const tenant = await withSystemContext(async (db) => {
      return await db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', tenantId)
        .executeTakeFirst();
    });

    if (!tenant) {
      throw new NotFoundError('Tenant');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: tenant.id,
      },
      'Retrieved tenant'
    );

    res.json({
      tenant,
      correlationId: req.correlationId,
    });
  })
);

// GET /api/tenants/slug/:slug - Get tenant by slug
router.get(
  '/slug/:slug',
  asyncHandler(async (req, res) => {
    const { slug } = req.params;

    const tenant = await withSystemContext(async (db) => {
      return await db
        .selectFrom('tenants')
        .selectAll()
        .where('slug', '=', slug)
        .executeTakeFirst();
    });

    if (!tenant) {
      throw new NotFoundError('Tenant');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: tenant.id,
        slug: tenant.slug,
      },
      'Retrieved tenant by slug'
    );

    res.json({
      tenant,
      correlationId: req.correlationId,
    });
  })
);

// POST /api/tenants - Create new tenant
router.post(
  '/',
  validate(createTenantSchema),
  asyncHandler(async (req, res) => {
    const tenant = await withSystemContext(async (db) => {
      return await db
        .insertInto('tenants')
        .values(req.body)
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: tenant.id,
        slug: tenant.slug,
      },
      'Created new tenant'
    );

    res.status(201).json({
      tenant,
      correlationId: req.correlationId,
    });
  })
);

// PATCH /api/tenants/:id - Update tenant
router.patch(
  '/:id',
  validate(updateTenantSchema),
  asyncHandler(async (req, res) => {
    const tenantId = uuidSchema.parse(req.params.id);

    const tenant = await withSystemContext(async (db) => {
      return await db
        .updateTable('tenants')
        .set(req.body)
        .where('id', '=', tenantId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!tenant) {
      throw new NotFoundError('Tenant');
    }

    logger.info(
      {
        correlationId: req.correlationId,
        tenantId: tenant.id,
      },
      'Updated tenant'
    );

    res.json({
      tenant,
      correlationId: req.correlationId,
    });
  })
);

// DELETE /api/tenants/:id - Delete tenant
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const tenantId = uuidSchema.parse(req.params.id);

    const deleted = await withSystemContext(async (db) => {
      return await db
        .deleteFrom('tenants')
        .where('id', '=', tenantId)
        .returningAll()
        .executeTakeFirst();
    });

    if (!deleted) {
      throw new NotFoundError('Tenant');
    }

    logger.warn(
      {
        correlationId: req.correlationId,
        tenantId: deleted.id,
        slug: deleted.slug,
      },
      'Deleted tenant (CASCADE will remove all related data)'
    );

    res.json({
      message: 'Tenant deleted successfully',
      tenant: deleted,
      correlationId: req.correlationId,
    });
  })
);

export default router;
