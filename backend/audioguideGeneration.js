import { Storage } from '@google-cloud/storage';
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { traceable } from "langsmith/traceable";
import fetch from 'node-fetch';
import { GoogleAuth } from 'google-auth-library';
import { createPreloadLocationSummariesNode } from './nodes/audioguide/preloadLocationSummaries.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_AUDIOGUIDE_MODEL = process.env.GEMINI_AUDIOGUIDE_MODEL || 'gemini-3-pro-preview';
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'itaytevel-hearandthere';

// Google Cloud Service Account credentials
// In production (Railway), this comes from GOOGLE_APPLICATION_CREDENTIALS_JSON env var
// In development, it reads from the JSON file
let googleCredentials = null;
function getGoogleCredentials() {
  if (!googleCredentials) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      // Production: Parse JSON from environment variable
      googleCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      console.log('[audioguide] Using Google Cloud credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON');
      console.log('[audioguide] Project ID:', googleCredentials.project_id);
      console.log('[audioguide] Service Account:', googleCredentials.client_email);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Development: Use file path
      console.log('[audioguide] Using Google Cloud credentials from file:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
      googleCredentials = null; // Let Google libraries auto-detect
    } else {
      throw new Error('Google Cloud credentials not configured. Set GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS');
    }
  }
  return googleCredentials;
}

// Initialize Google Cloud Storage client
let storageClient = null;
function getStorageClient() {
  if (!storageClient) {
    const credentials = getGoogleCredentials();
    storageClient = new Storage(
      credentials ? { credentials } : {}
    );
  }
  return storageClient;
}

// Initialize Google Auth client for TTS API
let authClient = null;
async function getAuthClient() {
  if (!authClient) {
    const credentials = getGoogleCredentials();
    authClient = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authClient;
}

// Lazy load LangChain Gemini model
let geminiModelPromise;
let fallbackModelPromise;

async function getGeminiModel(useFallback = false) {
  const modelName = useFallback ? 'gemini-2.5-pro' : GEMINI_AUDIOGUIDE_MODEL;
  const modelPromise = useFallback ? fallbackModelPromise : geminiModelPromise;

  if (!modelPromise) {
    const promise = import('@langchain/google-genai')
      .then((mod) => {
        if (!GEMINI_API_KEY) {
          console.warn('[audioguide] GEMINI_API_KEY not set');
          return null;
        }
        const { ChatGoogleGenerativeAI } = mod;
        console.log(`[audioguide] Creating model: ${modelName}`);
        return new ChatGoogleGenerativeAI({
          apiKey: GEMINI_API_KEY,
          model: modelName,
          temperature: 0.7,
        });
      })
      .catch((err) => {
        console.warn('[audioguide] Failed to load Gemini model', err);
        return null;
      });

    if (useFallback) {
      fallbackModelPromise = promise;
    } else {
      geminiModelPromise = promise;
    }
    return promise;
  }
  return modelPromise;
}

// Lazy load LangGraph modules
let langGraphModulesPromise;
async function getLangGraphModules() {
  if (!langGraphModulesPromise) {
    langGraphModulesPromise = import('@langchain/langgraph')
      .then((mod) => ({
        StateGraph: mod.StateGraph,
        START: mod.START,
        END: mod.END,
        Send: mod.Send,
        Command: mod.Command,
        Annotation: mod.Annotation,
      }))
      .catch((err) => {
        console.warn('[audioguide] Failed to load @langchain/langgraph', err);
        return null;
      });
  }
  return langGraphModulesPromise;
}

/**
 * Generate content with retry using LangChain model
 * Falls back to gemini-2.5-pro if API errors occur (rate limits, quota, permissions, etc.)
 */
async function generateWithRetry(prompt, maxRetries = 3) {
  let useFallback = false;
  let currentModelName = GEMINI_AUDIOGUIDE_MODEL;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const model = await getGeminiModel(useFallback);
      if (!model) {
        throw new Error('Gemini model not available');
      }

      console.log(`[audioguide] Generating content with ${currentModelName} (attempt ${attempt + 1})`);

      const response = await model.invoke(prompt);
      const script = response.content || '';

      if (!script || script.trim().length === 0) {
        throw new Error('Empty response from model');
      }

      console.log(`[audioguide] Successfully generated content (${script.length} chars)`);
      return { script, modelUsed: currentModelName };

    } catch (err) {
      const errorMessage = err.message || '';
      const statusCode = err.response?.status || err.status;

      console.warn(`[audioguide] Generation failed (attempt ${attempt + 1}):`, errorMessage);

      // Check if it's an API error (4xx or 5xx status codes, or specific error messages)
      // This includes: 403 (forbidden), 429 (rate limit), 500 (server error), etc.
      const isApiError = (statusCode && (statusCode >= 400)) ||
                         errorMessage.includes('429') ||
                         errorMessage.includes('403') ||
                         errorMessage.includes('rate limit') ||
                         errorMessage.includes('quota exceeded') ||
                         errorMessage.includes('RESOURCE_EXHAUSTED') ||
                         errorMessage.includes('PERMISSION_DENIED') ||
                         errorMessage.includes('forbidden') ||
                         errorMessage.includes('unauthorized');

      // If API error and not already using fallback, switch to fallback model
      if (isApiError && !useFallback) {
        console.warn(`[audioguide] ⚠️  API error detected (status: ${statusCode || 'unknown'})! Falling back to gemini-2.5-pro`);
        useFallback = true;
        currentModelName = 'gemini-2.5-pro';
        // Don't count this as a retry attempt, just switch models and try again immediately
        continue;
      }

      // Increment attempt counter for non-fallback retries
      attempt++;

      // If it's the last attempt, throw the error
      if (attempt >= maxRetries) {
        throw err;
      }

      // Wait before retry with exponential backoff
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`[audioguide] Waiting ${delay}ms before retry`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Failed to generate content after retries');
}

/**
 * Generate script for tour introduction
 */
async function generateIntroScript({ tour, locationSummaries, language, areaContext }) {
  const languageInstruction = language === 'hebrew'
    ? 'Write the ENTIRE script in HEBREW (עברית). Use natural, conversational Hebrew.'
    : 'Write the ENTIRE script in ENGLISH.';

  // Build comprehensive area context from ALL locations in the tour
  let areaContextText = '';

  if (locationSummaries && Object.keys(locationSummaries).length > 0) {
    // Group by city to avoid duplication
    const citiesMap = new Map();
    const neighborhoodsMap = new Map();

    for (const [locationKey, locationData] of Object.entries(locationSummaries)) {
      const { country, city, neighborhood, cityData, neighborhoodData } = locationData;

      // Add city data (only once per city)
      if (city && cityData && !citiesMap.has(city)) {
        citiesMap.set(city, cityData);
      }

      // Add neighborhood data (only once per neighborhood)
      if (neighborhood && neighborhoodData && !neighborhoodsMap.has(neighborhood)) {
        neighborhoodsMap.set(neighborhood, neighborhoodData);
      }
    }

    // Build context text with all cities
    if (citiesMap.size > 0) {
      areaContextText += '\nCities on this tour:\n';
      for (const [cityName, cityData] of citiesMap) {
        areaContextText += `\n${cityName}:\n${cityData.summary}`;
        if (cityData.keyFacts && cityData.keyFacts.length > 0) {
          areaContextText += `\nKey Facts:\n${cityData.keyFacts.map(fact => `- ${fact}`).join('\n')}`;
        }
        areaContextText += '\n';
      }
    }

    // Build context text with all neighborhoods
    if (neighborhoodsMap.size > 0) {
      areaContextText += '\nNeighborhoods on this tour:\n';
      for (const [neighborhoodName, neighborhoodData] of neighborhoodsMap) {
        areaContextText += `\n${neighborhoodName}:\n${neighborhoodData.summary}`;
        if (neighborhoodData.keyFacts && neighborhoodData.keyFacts.length > 0) {
          areaContextText += `\nKey Facts:\n${neighborhoodData.keyFacts.map(fact => `- ${fact}`).join('\n')}`;
        }
        areaContextText += '\n';
      }
    }
  }

  if (!areaContextText || areaContextText.trim() === '') {
    areaContextText = '\nNo additional context available';
    console.warn('[generateIntroScript] ⚠️ WARNING: No location summaries available for intro!');
  }

  // Extract neighborhood intro script from areaContext
  const neighborhoodIntroScript = areaContext?.neighborhoodData?.intro_script || null;
  const neighborhoodIntroSection = neighborhoodIntroScript
    ? `\nNeighbourhood intro script, this was played just before what you need to produce:\n${neighborhoodIntroScript}\n`
    : '';

  const prompt = `You are a professional tour guide creating an engaging audio introduction for a walking tour.

Tour Details:
- Title: ${tour.title}
- Theme: ${tour.theme}
- Abstract: ${tour.abstract}
- Number of stops: ${tour.stops.length}
- Estimated duration: ${tour.estimatedTotalMinutes} minutes

Context about the areas you'll visit:${areaContextText}

Create a warm, engaging 2 minute tour introduction script that:
1. Introduces the tour theme and what makes it special
2. Gives a brief overview of what they'll experience and the areas they'll explore
3. Don't repeate the same content of the neighborhood introduction and make this tour intro to be natuarlly continuation of the neighborhood introduction.
4. Sets an enthusiastic, friendly tone
5. Mentions the number of stops and approximate duration
${neighborhoodIntroSection}
${languageInstruction}
Write in a natural, conversational style as if speaking directly to the visitor.
Do NOT include stage directions or speaker labels - just the script text.`;

  try {
    const { script, modelUsed } = await generateWithRetry(prompt);
    return { script, modelUsed };
  } catch (err) {
    console.error('[audioguide] Failed to generate intro script', err);
    throw err;
  }
}

/**
 * Generate script for a specific stop
 */
async function generateStopScript({ stop, stopIndex, totalStops, tour, areaContext, nextStop, previousStop, language }) {
  const isFirst = stopIndex === 0;
  const isLast = stopIndex === totalStops - 1;

  const languageInstruction = language === 'hebrew'
    ? 'Write the ENTIRE script in HEBREW (עברית). Use natural, conversational Hebrew.'
    : 'Write the ENTIRE script in ENGLISH.';

  // Build walking directions context for the NEXT leg (after this stop)
  let walkingContext = '';
  if (!isLast && nextStop) {
    const walkTime = nextStop.walkMinutesFromPrevious || 0;
    const distance = nextStop.distanceMeters ? `${Math.round(nextStop.distanceMeters)}m` : '';
    const streetNames = nextStop.streetNames || [];
    const walkingDirections = nextStop.walkingDirections;

    walkingContext = `\n\nWalking Directions to Next Stop (${nextStop.name}):
- Walking time: ${walkTime} minute${walkTime !== 1 ? 's' : ''}${distance ? ` (${distance})` : ''}`;

    if (streetNames.length > 0) {
      walkingContext += `\n- Streets you'll walk on: ${streetNames.join(', ')}`;
    }

    if (walkingDirections && walkingDirections.steps && walkingDirections.steps.length > 0) {
      walkingContext += `\n- Turn-by-turn directions:\n${walkingDirections.steps.map((d, i) => `  ${i + 1}. ${d.instruction.replace(/<[^>]*>/g, '')} (${d.distance})`).join('\n')}`;
    }
  }

  // Build area context with city and neighborhood summaries and key facts
  let areaContextText = '';

  if (areaContext.cityData?.summary) {
    areaContextText += `\nCity Context (${areaContext.city}):\n${areaContext.cityData.summary}`;
  }

  if (areaContext.cityData?.keyFacts && areaContext.cityData.keyFacts.length > 0) {
    areaContextText += `\n\nKey Facts about ${areaContext.city}:\n${areaContext.cityData.keyFacts.map(fact => `- ${fact}`).join('\n')}`;
  }

  if (areaContext.neighborhoodData?.summary) {
    areaContextText += `\n\nNeighborhood Context (${areaContext.neighborhood}):\n${areaContext.neighborhoodData.summary}`;
  }

  if (areaContext.neighborhoodData?.keyFacts && areaContext.neighborhoodData.keyFacts.length > 0) {
    areaContextText += `\n\nKey Facts about ${areaContext.neighborhood}:\n${areaContext.neighborhoodData.keyFacts.map(fact => `- ${fact}`).join('\n')}`;
  }

  // Debug logging
  if (!areaContextText || areaContextText.trim() === '') {
    console.warn(`[generateStopScript] ⚠️ WARNING: Empty area context for stop "${stop.name}"!`);
    console.warn(`[generateStopScript] areaContext:`, JSON.stringify(areaContext, null, 2));
  }

  const prompt = `You are a professional tour guide creating an engaging audio script for stop ${stopIndex + 1} of ${totalStops} on a walking tour.

Stop Details:
- Name: ${stop.name}
- Location: ${areaContext.neighborhood || areaContext.city || 'the area'}
- Tour theme: ${tour.theme}
${isFirst ? '- This is the FIRST stop' : ''}
${!isFirst && previousStop ? `- Previous stop: ${previousStop.name}` : ''}
${isLast ? '- This is the LAST stop - include closing remarks' : ''}

Context about the area:${areaContextText}
${walkingContext}

Create an engaging 1-5 minute audio script that:
1. ${isFirst ? 'Welcomes them to the first stop' : `Introduces stop ${stopIndex + 1}`}
2. Shares fascinating historical facts, stories, or cultural significance about ${stop.name}
3. Points out interesting architectural or visual details they should notice
4. Includes surprising or little-known facts that tourists would love
5. ${isLast ? 'Concludes the tour with warm closing remarks and thanks them for joining' : `Provides clear walking directions to the next stop, mentioning the street names and any interesting context about those streets (historical significance, famous buildings, local culture, etc.)`}
6. The length depends on the richnest of the stop, the more depth the stop has the longer the script should be.

${!isLast ? `IMPORTANT: End the script by guiding them to the next stop. Use the walking directions provided above to give them clear, friendly guidance. If the streets have interesting historical or cultural significance, mention it! For example: "Now we'll head down Ben Yehuda Street, named after the father of modern Hebrew, where you'll see..."` : ''}

${languageInstruction}
Write in a natural, conversational, enthusiastic style as if you're walking with them.
Do NOT include stage directions or speaker labels - just the script text.
Keep it between 500-750 words.
${isLast ? 'End with a memorable closing that thanks them and wishes them well.' : ''}`;

  try {
    const { script, modelUsed } = await generateWithRetry(prompt);
    return { script, modelUsed };
  } catch (err) {
    console.error(`[audioguide] Failed to generate script for stop ${stopIndex}`, err);
    throw err;
  }
}



/**
 * Synthesize text to speech using Google Cloud TTS REST API with service account
 * and upload to Google Cloud Storage
 */
const synthesizeAudio = traceable(async ({ text, outputFileName, language, voice }) => {
  // Google TTS has a 5000 byte limit for text input
  const MAX_BYTES = 4998; // Leave small buffer

  // Check byte length and trim if necessary
  let processedText = text;
  const textBytes = Buffer.byteLength(text, 'utf8');

  if (textBytes > MAX_BYTES) {
    console.warn(`[audioguide] WARNING: Script exceeds TTS limit!`);
    console.warn(`[audioguide] File: ${outputFileName}`);
    console.warn(`[audioguide] Original size: ${textBytes} bytes (limit: 5000 bytes)`);

    // Trim text to fit within byte limit
    // We need to trim by bytes, not characters, to handle multi-byte UTF-8 characters
    let trimmedText = text;
    while (Buffer.byteLength(trimmedText, 'utf8') > MAX_BYTES) {
      // Remove last 10% of characters and try again
      const newLength = Math.floor(trimmedText.length * 0.9);
      trimmedText = trimmedText.substring(0, newLength);
    }

    // Add ellipsis to indicate truncation
    processedText = trimmedText.trim() + '...';

    const finalBytes = Buffer.byteLength(processedText, 'utf8');
    console.warn(`[audioguide] Trimmed to: ${finalBytes} bytes (${Math.round((finalBytes/textBytes)*100)}% of original)`);
  }

  // Determine language code from voice name
  const languageCode = voice.startsWith('he-') ? 'he-IL' :
                       voice.startsWith('en-GB-') ? 'en-GB' : 'en-US';

  // Use the provided voice
  const voiceConfig = {
    languageCode: languageCode,
    name: voice,
  };

  const requestBody = {
    input: { text: processedText },
    voice: voiceConfig,
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0.0,
    },
  };

  try {
    // Get authenticated client
    const auth = await getAuthClient();
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    if (!accessToken.token) {
      throw new Error('Failed to get access token from service account');
    }

    // Call Google Cloud TTS REST API with OAuth token
    const ttsUrl = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const audioContent = Buffer.from(data.audioContent, 'base64');

    // Upload to Google Cloud Storage
    const storage = getStorageClient();
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(outputFileName);

    await file.save(audioContent, {
      metadata: {
        contentType: 'audio/mpeg',
      },
    });

    // Get public URL (bucket must have allUsers:objectViewer permission)
    const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${outputFileName}`;

    console.log(`[audioguide] Audio uploaded to GCS: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error('[audioguide] Failed to synthesize audio', err);
    throw err;
  }
}, { name: 'synthesizeAudio', run_type: 'tool' });

/**
 * Build the audioguide generation graph
 */
export async function buildAudioguideGraph({ sessionId, tourId, language, voice, redisClient }) {
  const modules = await getLangGraphModules();
  if (!modules) {
    throw new Error('LangGraph modules not available');
  }

  const { StateGraph, START, END, Send, Command, Annotation } = modules;

  // Define AudioguideState
  const AudioguideState = Annotation.Root({
    tourId: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    selectedTour: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    areaContext: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => null,
    }),
    language: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => 'english',
    }),
    voice: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => 'en-GB-Wavenet-B',
    }),
    locationSummaries: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => ({}),
    }),
    stopLocationMap: Annotation({
      reducer: (x, y) => y ?? x,
      default: () => ({}),
    }),
    scripts: Annotation({
      reducer: (x, y) => {
        if (!y) return x;
        const result = { ...x };
        if (y.intro !== undefined) result.intro = y.intro;
        if (y.stops !== undefined) {
          // Merge stops arrays properly
          result.stops = [...(x.stops || [])];
          if (Array.isArray(y.stops)) {
            y.stops.forEach((stop, index) => {
              if (stop !== undefined && stop !== null) {
                result.stops[index] = stop;
              }
            });
          }
        }
        return result;
      },
      default: () => ({ intro: null, stops: [] }),
    }),
    audioFiles: Annotation({
      reducer: (x, y) => {
        if (!y) return x;
        const result = { ...x };
        if (y.intro !== undefined) result.intro = y.intro;
        if (y.stops !== undefined) {
          // Merge stops arrays properly
          result.stops = [...(x.stops || [])];
          if (Array.isArray(y.stops)) {
            y.stops.forEach((stop, index) => {
              if (stop !== undefined && stop !== null) {
                result.stops[index] = stop;
              }
            });
          }
        }
        return result;
      },
      default: () => ({ intro: null, stops: [] }),
    }),
  });

  // Node: Load tour and context from previous graph state
  const loadTourDataNode = async (state) => {
    console.log('[audioguide] Loading tour data for tourId:', state.tourId);

    // In a real implementation, we'd load from the checkpointer
    // For now, we'll expect it to be passed in the initial state
    if (!state.selectedTour || !state.areaContext) {
      throw new Error('Tour data not available in state');
    }

    return {
      selectedTour: state.selectedTour,
      areaContext: state.areaContext,
    };
  };

  // Create the preload location summaries node
  const preloadLocationSummariesNode = createPreloadLocationSummariesNode({ redisClient });

  // Node: Fan-out to generate all scripts in parallel
  const fanOutScriptsNode = async (state) => {
    const { selectedTour, areaContext } = state;
    const stops = selectedTour.stops || [];

    console.log('[audioguide] Fanning out script generation for', stops.length + 1, 'items');

    // Create Send commands for parallel execution
    const sends = [
      // Generate intro script
      new Send('generate_script', {
        ...state,
        scriptType: 'intro',
        stopIndex: -1,
      }),
      // Generate script for each stop
      ...stops.map((stop, index) =>
        new Send('generate_script', {
          ...state,
          scriptType: 'stop',
          stopIndex: index,
          stop,
          nextStop: index < stops.length - 1 ? stops[index + 1] : null, // Pass next stop for walking directions
          previousStop: index > 0 ? stops[index - 1] : null, // Pass previous stop for context
        })
      ),
    ];

    // Wrap in Command object
    return new Command({
      goto: sends,
    });
  };

  // Node: Generate a single script (intro or stop)
  const generateScriptNode = async (state) => {
    const { scriptType, stopIndex, selectedTour, areaContext, stop, nextStop, previousStop, language, locationSummaries, stopLocationMap, tourId } = state;

    console.log(`[audioguide] Generating ${scriptType} script, stopIndex:`, stopIndex, 'language:', language);

    let result;
    if (scriptType === 'intro') {
      result = await generateIntroScript({ tour: selectedTour, locationSummaries, language, areaContext });

      // Save intro script to Redis immediately
      const tourDataKey = `tour:${tourId}`;
      try {
        await redisClient.json.set(tourDataKey, '$.scripts.intro', {
          status: 'complete',
          content: result.script,
          modelUsed: result.modelUsed
        });
        console.log(`[audioguide] ✅ Saved intro script to Redis for tour ${tourId}`);
      } catch (err) {
        console.warn(`[audioguide] Failed to save intro script to Redis:`, err);
      }

      return {
        scripts: {
          intro: {
            status: 'complete',
            content: result.script,
            modelUsed: result.modelUsed
          },
        },
      };
    } else {
      // For stop scripts, use preloaded location summaries from memory
      // This ensures each stop uses the correct city/neighborhood data without generating new summaries
      let poiAreaContext = areaContext; // Default to tour-level context

      if (stopLocationMap && locationSummaries && stopLocationMap[stopIndex]) {
        // Look up the location key for this stop index
        const locationKey = stopLocationMap[stopIndex];

        if (locationSummaries[locationKey]) {
          // Use preloaded summaries from memory
          poiAreaContext = locationSummaries[locationKey];
          console.log(`[audioguide] Using preloaded context for "${stop.name}" (stop ${stopIndex}): ${poiAreaContext.city || 'unknown'}${poiAreaContext.neighborhood ? ` (${poiAreaContext.neighborhood})` : ''}`);
        } else {
          console.warn(`[audioguide] No preloaded summaries found for "${stop.name}" (${locationKey}), using tour-level context`);
        }
      } else {
        console.warn(`[audioguide] No location mapping found for stop ${stopIndex} ("${stop.name}"), using tour-level context`);
      }

      result = await generateStopScript({
        stop,
        stopIndex,
        totalStops: selectedTour.stops.length,
        tour: selectedTour,
        areaContext: poiAreaContext, // Use POI-specific context
        nextStop,
        previousStop,
        language,
      });

      // Update the specific stop script
      const updatedStops = [...(state.scripts?.stops || [])];
      updatedStops[stopIndex] = {
        status: 'complete',
        content: result.script,
        modelUsed: result.modelUsed
      };

      // Save stop script to Redis immediately
      const tourDataKey = `tour:${tourId}`;
      try {
        // First ensure the stops array exists and has enough elements
        const currentScripts = await redisClient.json.get(tourDataKey, { path: '$.scripts.stops' });
        const stopsArray = (Array.isArray(currentScripts) && currentScripts.length > 0) ? currentScripts[0] : [];
        
        // Extend array if needed
        while (stopsArray.length <= stopIndex) {
          stopsArray.push(null);
        }
        
        // Update the entire stops array first
        await redisClient.json.set(tourDataKey, '$.scripts.stops', stopsArray);
        
        // Now set the specific stop
        await redisClient.json.set(tourDataKey, `$.scripts.stops[${stopIndex}]`, {
          status: 'complete',
          content: result.script,
          modelUsed: result.modelUsed
        });
        console.log(`[audioguide] ✅ Saved stop ${stopIndex} script to Redis for tour ${tourId}`);
      } catch (err) {
        console.warn(`[audioguide] Failed to save stop ${stopIndex} script to Redis:`, err);
      }

      return {
        scripts: {
          stops: updatedStops,
        },
      };
    }
  };

  // Node: Fan-out to generate all audio files in parallel
  const fanOutAudioNode = async (state) => {
    const { scripts, selectedTour } = state;
    const stops = selectedTour.stops || [];

    console.log('[audioguide] Fanning out audio synthesis for', stops.length + 1, 'items');

    const sends = [
      // Synthesize intro audio
      new Send('synthesize_audio', {
        ...state,
        audioType: 'intro',
        stopIndex: -1,
        text: scripts.intro?.content,
      }),
      // Synthesize audio for each stop
      ...stops.map((stop, index) =>
        new Send('synthesize_audio', {
          ...state,
          audioType: 'stop',
          stopIndex: index,
          text: scripts.stops[index]?.content,
        })
      ),
    ];

    // Wrap in Command object
    return new Command({
      goto: sends,
    });
  };

  // Node: Synthesize a single audio file (intro or stop)
  const synthesizeAudioNode = async (state) => {
    const { audioType, stopIndex, text, tourId, language, voice } = state;

    if (!text) {
      console.warn(`[audioguide] No text available for ${audioType} at stopIndex ${stopIndex}`);
      return {};
    }

    console.log(`[audioguide] Synthesizing ${audioType} audio, stopIndex:`, stopIndex, 'language:', language, 'voice:', voice);

    const fileName = audioType === 'intro'
      ? `${tourId}_intro.mp3`
      : `${tourId}_stop_${stopIndex}.mp3`;

    const audioUrl = await synthesizeAudio({ text, outputFileName: fileName, language, voice });

    if (audioType === 'intro') {
      return {
        audioFiles: {
          intro: { status: 'complete', url: audioUrl },
        },
      };
    } else {
      const updatedStops = [...(state.audioFiles?.stops || [])];
      updatedStops[stopIndex] = { status: 'complete', url: audioUrl };

      return {
        audioFiles: {
          stops: updatedStops,
        },
      };
    }
  };

  // Create Redis checkpointer with 2-hour TTL to prevent Redis bloat
  let checkpointer = null;
  try {
    checkpointer = new RedisSaver(redisClient, {
      ttl: {
        default_ttl: 120, // 2 hours in minutes
        refresh_on_read: false // Don't refresh TTL on read
      }
    });
    console.log('[audioguide] Using Redis checkpointer (TTL: 2 hours)');
  } catch (err) {
    console.warn('[audioguide] Redis checkpointer failed to initialize:', err.message);
  }

  // Build the graph
  const graph = new StateGraph(AudioguideState)
    .addNode('load_tour_data', loadTourDataNode)
    .addNode('preload_location_summaries', preloadLocationSummariesNode)
    .addNode('fan_out_scripts', fanOutScriptsNode, { ends: ['generate_script'] })
    .addNode('generate_script', generateScriptNode)
    .addNode('fan_out_audio', fanOutAudioNode, { ends: ['synthesize_audio'] })
    .addNode('synthesize_audio', synthesizeAudioNode)
    .addEdge(START, 'load_tour_data')
    .addEdge('load_tour_data', 'preload_location_summaries')
    .addEdge('preload_location_summaries', 'fan_out_scripts')
    .addEdge('generate_script', 'fan_out_audio')
    .addEdge('synthesize_audio', END)
    .compile(checkpointer ? { checkpointer } : {});

  return graph;
}

/**
 * Main function to generate audioguide for a tour
 */
export async function generateAudioguide({ sessionId, tourId, selectedTour, areaContext, language, voice, redisClient }) {
  console.log('[audioguide] Starting audioguide generation for tour:', tourId, 'language:', language, 'voice:', voice);

  const graph = await buildAudioguideGraph({ sessionId, tourId, language, voice, redisClient });

  const config = {
    configurable: { thread_id: `${sessionId}_audioguide_${tourId}` },
  };

  const finalState = await graph.invoke(
    {
      tourId,
      selectedTour,
      areaContext,
      language: language || 'english',
      voice: voice || (language === 'hebrew' ? 'he-IL-Standard-D' : 'en-GB-Wavenet-B'),
    },
    config
  );

  return {
    scripts: finalState.scripts,
    audioFiles: finalState.audioFiles,
  };
}

/**
 * Generate TTS audio for neighborhood intro script
 * Uses the same synthesizeAudio function as the audioguide generation
 *
 * @param {Object} params
 * @param {string} params.introScript - The intro script text
 * @param {string} params.outputFileName - Output filename (e.g., "neighborhood_intro_uuid.mp3")
 * @param {string} params.language - Language (e.g., 'english', 'hebrew')
 * @param {string} params.voice - Voice name (optional, will use default for language)
 * @returns {Promise<string>} Audio URL
 */
export async function generateNeighborhoodIntroAudio({ introScript, outputFileName, language, voice }) {
  console.log('[audioguide] Generating neighborhood intro audio:', {
    outputFileName,
    language,
    voice,
    textLength: introScript.length
  });

  // Determine voice if not provided
  const selectedVoice = voice || (language === 'hebrew' ? 'he-IL-Standard-D' : 'en-GB-Wavenet-B');

  // Use the same synthesizeAudio function
  const audioUrl = await synthesizeAudio({
    text: introScript,
    outputFileName,
    language,
    voice: selectedVoice
  });

  console.log('[audioguide] ✅ Neighborhood intro audio generated:', audioUrl);
  return audioUrl;
}

