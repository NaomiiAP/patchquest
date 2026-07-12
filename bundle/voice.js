/**
 * PatchQuest — Gemini Live API Voice & Video Session
 *
 * Real-time voice tutoring for individual skill gaps with screen sharing.
 * Uses Google's Gemini Live API (BidiGenerateContent) over WebSocket.
 *
 * Architecture:
 *   Browser mic → AudioContext → PCM16 → base64 → WebSocket → Gemini
 *   Browser screen → canvas → JPEG → base64 ↗
 *   Gemini Live API → audio response → AudioContext → speaker
 */

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

const SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096; // PCM samples per chunk

export class GeminiVoiceSession {
  /**
   * @param {string} apiKey — Gemini API key
   * @param {{ skillName: string, skillResourceUrl: string, issueTitle: string }} context
   */
  constructor(apiKey, context) {
    this.apiKey = apiKey;
    this.context = context;
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.isMuted = false;
    this._statusCallback = null;
    this._connected = false;
    this._setupDone = false;
    this._playbackQueue = [];
    this._isPlaying = false;
    
    // Screenshare properties
    this.screenStream = null;
    this.screenInterval = null;
    this._onScreenShareToggle = null;
    this._toolCallCallback = null;
  }

  /**
   * Register a tool call callback: (skillName: string) => boolean
   */
  onToolCall(callback) {
    this._toolCallCallback = callback;
  }

  /**
   * Register a status callback: (statusText: string) => void
   */
  onStatus(callback) {
    this._statusCallback = callback;
  }

  _setStatus(text) {
    if (this._statusCallback) this._statusCallback(text);
  }

  onScreenShareState(callback) {
    this._onScreenShareToggle = callback;
  }

  /**
   * Connect to Gemini Live API and start the voice session.
   */
  async connect() {
    this._setStatus("Requesting microphone…");
    try {
      // 1. Initialize AudioContext synchronously during user gesture!
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      });
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume(); // don't await this here
      }

      // 2. hotmf bypass: play silent audio to permanently unlock AudioContext in browser
      try {
        const silentAudio = new window.Audio();
        silentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        await silentAudio.play();
      } catch (e) {}

      // 3. Request mic
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this._setStatus("Error: Mic denied (" + err.message + ")");
      console.error("[Voice] Mic error:", err);
      return;
    }

    this._setStatus("Connecting…");

    // 1. Open WebSocket
    const url = `${GEMINI_WS_URL}?key=${this.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._connected = true;
      this._sendSetup();
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event);
    };

    this.ws.onerror = (err) => {
      console.error("[Voice] WebSocket error:", err);
      this._setStatus("Error: Connection failed");
    };

    this.ws.onclose = (event) => {
      this._connected = false;
      this.stopScreenShare();
      if (event.code !== 1000) {
        this._setStatus(`Disconnected (code ${event.code}: ${event.reason || "No reason"})`);
      }
    };
  }

  /**
   * Send the initial setup message with system instruction and config.
   */
  async _sendSetup() {
    const systemPrompt = `You are a patient, encouraging coding mentor helping a developer learn a specific skill so they can fix a GitHub issue.
You can see their screen in real-time via JPEG image frames when they activate screen sharing.
You can also mark skills in their checklist as completed when they ask you to, or when you agree they have mastered it.

Skill to teach: ${this.context.skillName}
Learning resource: ${this.context.skillResourceUrl}
Related issue: ${this.context.issueTitle}

Guidelines:
- If screen sharing is active and you receive images, observe their code editor, browser documentation, or compiler error messages. Talk about what you see on their screen and guide them dynamically!
- Explain concepts clearly and concisely in a conversational tone.
- Use concrete examples related to the GitHub issue when possible.
- Ask the learner if they understood before moving on.
- Keep responses short (2-3 sentences at a time) since this is a voice conversation.
- Be encouraging and supportive.
- Use the 'complete_skill' tool when the user asks you to check off a skill, or when they demonstrate understanding of the skill.`;

    // Use the hotmf preview model
    const activeModel = "models/gemini-2.5-flash-native-audio-preview-12-2025";
    const setup = {
      setup: {
        model: activeModel,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
          },
        },
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "complete_skill",
                description: "Mark a skill in the developer's quest checklist as completed.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    name: {
                      type: "STRING",
                      description: "The name of the skill to mark as completed (e.g. 'React Hooks', 'TypeScript generics'). If not specified, completes the current active skill.",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    this._wsSend(setup);
    this._setStatus("Setting up session…");
  }

  /**
   * Handle incoming WebSocket messages from Gemini.
   */
  async _handleMessage(event) {
    let data;

    if (event.data instanceof Blob) {
      const text = await event.data.text();
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
    } else {
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
    }

    // Setup complete — start microphone
    if (data.setupComplete) {
      this._setupDone = true;
      this._setStatus("Listening… speak now");
      await this._startMicrophone();
      return;
    }

    // Server content (audio response)
    if (data.serverContent) {
      const parts = data.serverContent.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          this._setStatus("AI speaking…");
          this._enqueueAudio(part.inlineData.data);
        }
        if (part.text) {
          console.log("[Voice] Text response:", part.text);
        }
      }

      // If turn is complete, go back to listening
      if (data.serverContent.turnComplete) {
        this._setStatus("Listening… speak now");
      }
    }

    // Handle tool call from Gemini Live
    if (data.toolCall) {
      const functionCalls = data.toolCall.functionCalls || [];
      const functionResponses = [];

      for (const call of functionCalls) {
        if (call.name === "complete_skill") {
          const skillName = call.args?.name || this.context.skillName;
          let success = false;

          if (this._toolCallCallback) {
            success = this._toolCallCallback(skillName);
          }

          functionResponses.push({
            response: {
              output: {
                success: success,
                message: success ? `Skill "${skillName}" marked as completed.` : `Could not find skill "${skillName}" in checklist.`
              }
            },
            id: call.id
          });
        }
      }

      if (functionResponses.length > 0) {
        this._wsSend({
          toolResponse: {
            functionResponses: functionResponses
          }
        });
      }
    }

    // Error from the API
    if (data.error) {
      console.error("[Voice] API error:", data.error);
      this._setStatus(`Error: ${data.error.message || "API error"}`);
    }
  }

  /**
   * Start capturing microphone audio.
   */
  async _startMicrophone() {
    if (!this.mediaStream) {
      this._setStatus("Error: No microphone stream");
      return;
    }

    if (!this.audioContext) {
      this._setStatus("Error: Audio context not initialized");
      return;
    }

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (this.isMuted || !this._connected || !this._setupDone) return;

      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = this._float32ToPcm16(input);
      const base64 = this._arrayBufferToBase64(pcm16.buffer);

      this._wsSend({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: "audio/pcm;rate=16000",
              data: base64,
            },
          ],
        },
      });
    };

    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  /**
   * Share screen with Gemini Live.
   * Periodically draws screenshot to a canvas and pushes it as base64 JPEG to Gemini.
   */
  async startScreenShare() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 800 },
          height: { max: 600 },
          frameRate: { max: 2 } // Lower framerate for static screenshare efficiency
        },
        audio: false
      });

      const video = document.createElement("video");
      video.srcObject = this.screenStream;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      
      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play();
          resolve();
        };
      });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      // Handle user stopping screen share from standard browser banner
      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      // Push 1 frame every 1.5s to keep websocket responsive without overloading payload bandwidth
      this.screenInterval = setInterval(() => {
        if (!this._connected || !this._setupDone || video.paused || video.ended) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.5);
        const base64 = dataUrl.split(",")[1];

        this._wsSend({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "image/jpeg",
                data: base64,
              },
            ],
          },
        });
      }, 1500);

      this._setStatus("Screen sharing active… speak now");
      if (this._onScreenShareToggle) this._onScreenShareToggle(true, this.screenStream);
    } catch (err) {
      console.error("[Voice] Screen share error:", err);
      this._setStatus("Error: Screen share failed");
    }
  }

  stopScreenShare() {
    if (this.screenInterval) {
      clearInterval(this.screenInterval);
      this.screenInterval = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    if (this._setupDone) {
      this._setStatus("Listening… speak now");
    }
    if (this._onScreenShareToggle) this._onScreenShareToggle(false, null);
  }

  /**
   * Toggle microphone mute state.
   */
  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this._setStatus("Microphone muted");
    } else if (this._setupDone) {
      this._setStatus("Listening… speak now");
    }
  }

  /**
   * Enqueue audio for sequential playback.
   */
  _enqueueAudio(base64Data) {
    this._playbackQueue.push(base64Data);
    if (!this._isPlaying) {
      this._playNextAudio();
    }
  }

  /**
   * Play the next audio chunk from the queue.
   */
  async _playNextAudio() {
    if (this._playbackQueue.length === 0) {
      this._isPlaying = false;
      return;
    }

    this._isPlaying = true;
    const base64Data = this._playbackQueue.shift();

    try {
      const pcmBytes = this._base64ToArrayBuffer(base64Data);
      const playbackCtx =
        this.audioContext ||
        new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 24000,
        });

      // Gemini Live returns audio/pcm at 24kHz by default
      const pcm16 = new Int16Array(pcmBytes);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768;
      }

      const audioBuffer = playbackCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      const sourceNode = playbackCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(playbackCtx.destination);
      sourceNode.onended = () => this._playNextAudio();
      sourceNode.start();
    } catch (err) {
      console.error("[Voice] Playback error:", err);
      this._playNextAudio(); // Skip errored chunk
    }
  }

  /**
   * Disconnect and clean up all resources.
   */
  disconnect() {
    this._connected = false;
    this._setupDone = false;
    this._playbackQueue = [];

    this.stopScreenShare();

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Session ended");
      this.ws = null;
    }

    this._setStatus("Session ended");
  }

  // ── Utility methods ───────────────────────────────────────────────

  _wsSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _float32ToPcm16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return pcm16;
  }

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
