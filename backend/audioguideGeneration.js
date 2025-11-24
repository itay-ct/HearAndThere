import { Storage } from '@google-cloud/storage';
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import fetch from 'node-fetch';
import { GoogleAuth } from 'google-auth-library';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_AUDIOGUIDE_MODEL = process.env.GEMINI_AUDIOGUIDE_MODEL || 'gemini-3-pro-preview';
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'hear-and-there-audio';

// Google Cloud Service Account credentials
// In production (Railway), this comes from GOOGLE_APPLICATION_CREDENTIALS_JSON env var
// In development, it reads from the JSON file
let googleCredentials = null;
function getGoogleCredentials() {
  if (!googleCredentials) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      // Production: Parse JSON from environment variable
      googleCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Development: Use file path
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

// Lazy load Gemini model
let geminiModelPromise;
async function getGeminiModel() {
  if (!geminiModelPromise) {
    geminiModelPromise = import('@google/generative-ai')
      .then((mod) => {
        if (!GEMINI_API_KEY) return null;
        const genAI = new mod.GoogleGenerativeAI(GEMINI_API_KEY);
        return genAI.getGenerativeModel({ model: GEMINI_AUDIOGUIDE_MODEL });
      })
      .catch((err) => {
        console.warn('[audioguide] Failed to load Gemini model', err);
        return null;
      });
  }
  return geminiModelPromise;
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
 * Generate script for tour introduction
 */
async function generateIntroScript({ tour, areaContext, language }) {
  const model = await getGeminiModel();
  if (!model) {
    throw new Error('Gemini model not available');
  }

  const languageInstruction = language === 'hebrew'
    ? 'Write the ENTIRE script in HEBREW (עברית). Use natural, conversational Hebrew.'
    : 'Write the ENTIRE script in ENGLISH.';

  const prompt = `You are a professional tour guide creating an engaging audio introduction for a walking tour.

Tour Details:
- Title: ${tour.title}
- Theme: ${tour.theme}
- Abstract: ${tour.abstract}
- Location: ${areaContext.neighborhood || areaContext.city || 'the area'}
- Number of stops: ${tour.stops.length}
- Estimated duration: ${tour.estimatedTotalMinutes} minutes

Context about the area:
${areaContext.cityData?.summary || 'No additional context available'}

Create a warm, engaging 2-3 minute introduction script that:
1. Welcomes the visitor
2. Introduces the tour theme and what makes it special
3. Gives a brief overview of what they'll experience
4. Sets an enthusiastic, friendly tone
5. Mentions the number of stops and approximate duration

${languageInstruction}
Write in a natural, conversational style as if speaking directly to the visitor.
Do NOT include stage directions or speaker labels - just the script text.
Keep it between 300-450 words.`;

  try {
    const response = await model.generateContent(prompt);
    const script = response.response.text();
    return script;
  } catch (err) {
    console.error('[audioguide] Failed to generate intro script', err);
    throw err;
  }
}

/**
 * Generate script for a specific stop
 */
async function generateStopScript({ stop, stopIndex, totalStops, tour, areaContext, nextStop, language }) {
  const model = await getGeminiModel();
  if (!model) {
    throw new Error('Gemini model not available');
  }

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

  const prompt = `You are a professional tour guide creating an engaging audio script for stop ${stopIndex + 1} of ${totalStops} on a walking tour.

Stop Details:
- Name: ${stop.name}
- Location: ${areaContext.neighborhood || areaContext.city || 'the area'}
- Tour theme: ${tour.theme}
${isFirst ? '- This is the FIRST stop' : ''}
${isLast ? '- This is the LAST stop - include closing remarks' : ''}

Context about the area:
${areaContext.cityData?.summary || ''}
${areaContext.neighborhoodData?.summary || ''}
${walkingContext}

Create an engaging 3-5 minute audio script that:
1. ${isFirst ? 'Welcomes them to the first stop' : `Introduces stop ${stopIndex + 1}`}
2. Shares fascinating historical facts, stories, or cultural significance about ${stop.name}
3. Points out interesting architectural or visual details they should notice
4. Includes surprising or little-known facts that tourists would love
5. ${isLast ? 'Concludes the tour with warm closing remarks and thanks them for joining' : `Provides clear walking directions to the next stop, mentioning the street names and any interesting context about those streets (historical significance, famous buildings, local culture, etc.)`}

${!isLast ? `IMPORTANT: End the script by guiding them to the next stop. Use the walking directions provided above to give them clear, friendly guidance. If the streets have interesting historical or cultural significance, mention it! For example: "Now we'll head down Ben Yehuda Street, named after the father of modern Hebrew, where you'll see..."` : ''}

${languageInstruction}
Write in a natural, conversational, enthusiastic style as if you're walking with them.
Do NOT include stage directions or speaker labels - just the script text.
Keep it between 500-750 words.
${isLast ? 'End with a memorable closing that thanks them and wishes them well.' : ''}`;

  try {
    const response = await model.generateContent(prompt);
    const script = response.response.text();
    return script;
  } catch (err) {
    console.error(`[audioguide] Failed to generate script for stop ${stopIndex}`, err);
    throw err;
  }
}



/**
 * Synthesize text to speech using Google Cloud TTS REST API with service account
 * and upload to Google Cloud Storage
 */
async function synthesizeAudio({ text, outputFileName, language }) {
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

  // Select voice based on language
  const voiceConfig = language === 'hebrew'
    ? {
        languageCode: 'he-IL',
        name: 'he-IL-Chirp3-HD-Alnilam', // Hebrew female voice
      }
    : {
        languageCode: 'en-US',
        name: 'en-US-Chirp3-HD-Charon', // English Chirp3-HD voice
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
}

/**
 * Build the audioguide generation graph
 */
export async function buildAudioguideGraph({ sessionId, tourId, language, redisClient }) {
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
    const { scriptType, stopIndex, selectedTour, areaContext, stop, nextStop, language } = state;

    console.log(`[audioguide] Generating ${scriptType} script, stopIndex:`, stopIndex, 'language:', language);

    let script;
    if (scriptType === 'intro') {
      script = await generateIntroScript({ tour: selectedTour, areaContext, language });
      return {
        scripts: {
          intro: { status: 'complete', content: script },
        },
      };
    } else {
      script = await generateStopScript({
        stop,
        stopIndex,
        totalStops: selectedTour.stops.length,
        tour: selectedTour,
        areaContext,
        nextStop, // Pass next stop for walking directions
        language,
      });

      // Update the specific stop script
      const updatedStops = [...(state.scripts?.stops || [])];
      updatedStops[stopIndex] = { status: 'complete', content: script };

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
    const { audioType, stopIndex, text, tourId, language } = state;

    if (!text) {
      console.warn(`[audioguide] No text available for ${audioType} at stopIndex ${stopIndex}`);
      return {};
    }

    console.log(`[audioguide] Synthesizing ${audioType} audio, stopIndex:`, stopIndex, 'language:', language);

    const fileName = audioType === 'intro'
      ? `${tourId}_intro.mp3`
      : `${tourId}_stop_${stopIndex}.mp3`;

    const audioUrl = await synthesizeAudio({ text, outputFileName: fileName, language });

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

  // Create Redis checkpointer
  let checkpointer = null;
  try {
    checkpointer = new RedisSaver(redisClient);
  } catch (err) {
    console.warn('[audioguide] Redis checkpointer failed to initialize:', err.message);
  }

  // Build the graph
  const graph = new StateGraph(AudioguideState)
    .addNode('load_tour_data', loadTourDataNode)
    .addNode('fan_out_scripts', fanOutScriptsNode, { ends: ['generate_script'] })
    .addNode('generate_script', generateScriptNode)
    .addNode('fan_out_audio', fanOutAudioNode, { ends: ['synthesize_audio'] })
    .addNode('synthesize_audio', synthesizeAudioNode)
    .addEdge(START, 'load_tour_data')
    .addEdge('load_tour_data', 'fan_out_scripts')
    .addEdge('generate_script', 'fan_out_audio')
    .addEdge('synthesize_audio', END)
    .compile(checkpointer ? { checkpointer } : {});

  return graph;
}

/**
 * Main function to generate audioguide for a tour
 */
export async function generateAudioguide({ sessionId, tourId, selectedTour, areaContext, language, redisClient }) {
  console.log('[audioguide] Starting audioguide generation for tour:', tourId, 'language:', language);

  const graph = await buildAudioguideGraph({ sessionId, tourId, language, redisClient });

  const config = {
    configurable: { thread_id: `${sessionId}_audioguide_${tourId}` },
  };

  const finalState = await graph.invoke(
    {
      tourId,
      selectedTour,
      areaContext,
      language: language || 'english',
    },
    config
  );

  return {
    scripts: finalState.scripts,
    audioFiles: finalState.audioFiles,
  };
}

