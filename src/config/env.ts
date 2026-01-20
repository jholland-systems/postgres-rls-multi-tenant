import { z } from 'zod';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// Environment variable schema with strict validation
const envSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database
  DATABASE_URL: z.string().url().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT: z.coerce.number().int().positive().default(10000),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  LOG_PRETTY: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),

  // JWT (for future auth implementation)
  JWT_SECRET: z.string().min(32).optional(),

  // Application
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
});

// Parse and validate environment variables
function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n  ');

      throw new Error(
        `❌ Environment validation failed:\n  ${missingVars}\n\nPlease check your .env file against .env.example`
      );
    }
    throw error;
  }
}

// Export validated environment variables
export const env = validateEnv();

// Export type for TypeScript autocomplete
export type Env = z.infer<typeof envSchema>;
