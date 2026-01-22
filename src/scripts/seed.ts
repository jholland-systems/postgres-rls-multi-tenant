#!/usr/bin/env node
/**
 * Seed data script
 * Populates database with demo tenants, users, projects, and tasks
 */

import { __dangerouslyGetRawDatabase as db } from '../database/client.js';
import { logger } from '../utils/logger.js';

async function seed() {
  try {
    logger.info('Starting database seed...');

    // Create demo tenants
    logger.info('Creating demo tenants...');
    const [acme, globex, initech] = await db
      .insertInto('tenants')
      .values([
        {
          name: 'Acme Corporation',
          slug: 'acme',
        },
        {
          name: 'Globex Industries',
          slug: 'globex',
        },
        {
          name: 'Initech Solutions',
          slug: 'initech',
        },
      ])
      .returningAll()
      .execute();

    logger.info(
      {
        tenants: [acme.name, globex.name, initech.name],
      },
      'Created demo tenants'
    );

    // Create users for Acme
    logger.info('Creating users for Acme...');
    const [acmeOwner, acmeAdmin, acmeMember] = await db
      .insertInto('users')
      .values([
        {
          tenant_id: acme.id,
          email: 'alice@acme.com',
          name: 'Alice Anderson',
          role: 'owner',
        },
        {
          tenant_id: acme.id,
          email: 'bob@acme.com',
          name: 'Bob Brown',
          role: 'admin',
        },
        {
          tenant_id: acme.id,
          email: 'charlie@acme.com',
          name: 'Charlie Chen',
          role: 'member',
        },
      ])
      .returningAll()
      .execute();

    // Create users for Globex
    logger.info('Creating users for Globex...');
    const [globexOwner, globexMember] = await db
      .insertInto('users')
      .values([
        {
          tenant_id: globex.id,
          email: 'diana@globex.com',
          name: 'Diana Davis',
          role: 'owner',
        },
        {
          tenant_id: globex.id,
          email: 'evan@globex.com',
          name: 'Evan Edwards',
          role: 'member',
        },
      ])
      .returningAll()
      .execute();

    // Create users for Initech
    logger.info('Creating users for Initech...');
    const [initechOwner] = await db
      .insertInto('users')
      .values([
        {
          tenant_id: initech.id,
          email: 'frank@initech.com',
          name: 'Frank Foster',
          role: 'owner',
        },
      ])
      .returningAll()
      .execute();

    logger.info(
      {
        acme: [acmeOwner.name, acmeAdmin.name, acmeMember.name],
        globex: [globexOwner.name, globexMember.name],
        initech: [initechOwner.name],
      },
      'Created demo users'
    );

    // Create projects for Acme
    logger.info('Creating projects for Acme...');
    const [acmeProject1, acmeProject2] = await db
      .insertInto('projects')
      .values([
        {
          tenant_id: acme.id,
          name: 'Website Redesign',
          description: 'Modernize corporate website',
          status: 'active',
        },
        {
          tenant_id: acme.id,
          name: 'Mobile App Launch',
          description: 'Launch iOS and Android apps',
          status: 'active',
        },
      ])
      .returningAll()
      .execute();

    // Create projects for Globex
    logger.info('Creating projects for Globex...');
    const [globexProject1] = await db
      .insertInto('projects')
      .values([
        {
          tenant_id: globex.id,
          name: 'Q4 Marketing Campaign',
          description: 'Holiday season marketing push',
          status: 'active',
        },
      ])
      .returningAll()
      .execute();

    // Create projects for Initech
    logger.info('Creating projects for Initech...');
    const [initechProject1] = await db
      .insertInto('projects')
      .values([
        {
          tenant_id: initech.id,
          name: 'TPS Report Automation',
          description: 'Automate TPS report generation',
          status: 'completed',
        },
      ])
      .returningAll()
      .execute();

    logger.info(
      {
        acme: [acmeProject1.name, acmeProject2.name],
        globex: [globexProject1.name],
        initech: [initechProject1.name],
      },
      'Created demo projects'
    );

    // Create tasks for Acme projects
    logger.info('Creating tasks for Acme...');
    await db
      .insertInto('tasks')
      .values([
        {
          tenant_id: acme.id,
          project_id: acmeProject1.id,
          title: 'Design mockups',
          description: 'Create design mockups for homepage',
          status: 'completed',
          assigned_to: acmeAdmin.id,
        },
        {
          tenant_id: acme.id,
          project_id: acmeProject1.id,
          title: 'Implement frontend',
          description: 'Build React components',
          status: 'in_progress',
          assigned_to: acmeMember.id,
        },
        {
          tenant_id: acme.id,
          project_id: acmeProject2.id,
          title: 'iOS development',
          description: 'Build iOS app with Swift',
          status: 'pending',
          assigned_to: null, // Unassigned
        },
      ])
      .execute();

    // Create tasks for Globex projects
    logger.info('Creating tasks for Globex...');
    await db
      .insertInto('tasks')
      .values([
        {
          tenant_id: globex.id,
          project_id: globexProject1.id,
          title: 'Create ad copy',
          description: 'Write compelling ad copy',
          status: 'in_progress',
          assigned_to: globexMember.id,
        },
        {
          tenant_id: globex.id,
          project_id: globexProject1.id,
          title: 'Design banner ads',
          description: 'Create banner ads for social media',
          status: 'pending',
          assigned_to: null, // Unassigned
        },
      ])
      .execute();

    // Create tasks for Initech projects
    logger.info('Creating tasks for Initech...');
    await db
      .insertInto('tasks')
      .values([
        {
          tenant_id: initech.id,
          project_id: initechProject1.id,
          title: 'Deploy to production',
          description: 'Deploy automation system',
          status: 'completed',
          assigned_to: initechOwner.id,
        },
      ])
      .execute();

    logger.info('Created demo tasks');

    // Summary
    logger.info(
      {
        tenants: 3,
        users: 7,
        projects: 4,
        tasks: 6,
      },
      'Database seed completed successfully'
    );

    logger.info(
      'Demo credentials:\n' +
        '  Acme: alice@acme.com (owner), bob@acme.com (admin), charlie@acme.com (member)\n' +
        '  Globex: diana@globex.com (owner), evan@globex.com (member)\n' +
        '  Initech: frank@initech.com (owner)'
    );

    await db.destroy();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Seed failed');
    await db.destroy();
    process.exit(1);
  }
}

seed();
