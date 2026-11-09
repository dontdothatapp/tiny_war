// ElevenLabs client — server-side only.
//
// Never import this from src/: that code ships to the browser, and the API key
// must never reach it. The SDK reads ELEVENLABS_API_KEY from the environment;
// the key lives in .env.local (gitignored). Load it when you run a script:
//
//   node --env-file=.env.local server/your-script.ts
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

export const elevenlabs = new ElevenLabsClient();
