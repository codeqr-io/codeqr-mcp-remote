/**
 * Vercel Serverless Function Entry Point
 * 
 * This file exports the Express app as a serverless handler for Vercel.
 * The app is imported from src/index.ts which exports the Express app instance.
 */

import app from '../src/index.js';

// Export the Express app as the default handler for Vercel
export default app;
