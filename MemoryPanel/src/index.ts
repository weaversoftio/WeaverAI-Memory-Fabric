// Unified entry point: starts the stateless panel directly (path A).
// The legacy path B has been removed; no PANEL_MODE fork is needed any more.
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { main } from './panel/index.js';
main();
