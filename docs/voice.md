# JARVIS voice and conversation (6.8)

How JARVIS listens, speaks and keeps a conversation going, which parts run on your laptop, and what each part costs.

## Speaking

| Voice | Where it runs | Cost | When it's used |
|---|---|---|---|
| ElevenLabs | ElevenLabs' servers | Billed by ElevenLabs to your key | Your key is set and the voice is "Automatic" or "ElevenLabs" |
| OpenAI | OpenAI's servers | Billed by OpenAI to your key | Your key is set and the voice is "Automatic" (no ElevenLabs key) or "OpenAI" |
| Local voice (Piper) | On your laptop | Free | No premium key with "Automatic", or chosen in Settings → Voice & conversation |
| Browser / Windows voice | Your device | Free | Nothing else is available, or chosen |

Settings only offers the voices that can actually be used. JARVIS never switches to a paid voice on its own.

### What makes speech sound less like reading

- **Sentence by sentence:** each sentence is voiced as soon as Claude has written it, so JARVIS starts talking within a sentence.
- **Text clean-up:** the same rules apply to every voice (`public/js/speech-text.js`):
  - links, markdown, list markers, citation numbers and emoji are never read out;
  - "£12.50" becomes "12 pounds 50", "21°C" becomes "21 degrees" and "40%" becomes "40 percent";
  - "e.g." becomes "for example";
  - dashes become a short pause, and line breaks become a sentence pause.
- **Pronunciations:** Settings → Voice & conversation → Pronunciations, one `word = how to say it` per line. They apply to every voice.
- **Speed:** a setting (0.8–1.2×) for every voice, plus "speak more slowly" / "speak faster" / "normal speed" for the rest of a conversation.
  - ElevenLabs: its speed parameter.
  - OpenAI: delivery instructions for gpt-4o-mini-tts (the speed parameter for older models).
  - Piper: its length scale.
  - Browser voice: the utterance rate.
  - The local voice changes speed less than the others: 0.8× makes a sentence about 11% longer, and 1.2× only slightly shorter, because Piper stretches the words but not the pauses.
- **Volume:** a setting that applies immediately, even mid-sentence.

### The local voice

- **Model:** Piper "northern_english_male" (medium quality), as converted by sherpa-onnx. It is run by sherpa-onnx, the engine JARVIS already uses for speech recognition.
- **Phonemes:** text is converted by espeak-ng through the `phonemizer` package, clause by clause, keeping punctuation so the voice pauses at commas and full stops.
- **Measured on this test machine (4 CPU threads, 2 used):**
  - 6.6 seconds of speech in 0.45 s;
  - about 0.35 s per sentence once loaded;
  - 1.5 s for the first sentence when cold, which is avoided by loading it at start-up when it's the voice in use;
  - repeated short phrases come from a cache instantly.
- **Size:** 63 MB, bundled in the Windows installer (downloaded and checksum-checked when the installer is built).
- **Licences and attribution:**
  - Voice dataset: OpenSLR 83 (Crowdsourced high-quality UK and Ireland English Dialect speech data set, Demirsahin et al., Google), **CC-BY-SA 4.0**.
  - Piper voice model trained from it by the Piper project (rhasspy).
  - sherpa-onnx: Apache-2.0.
  - `phonemizer` (npm): Apache-2.0, bundling espeak-ng data (GPL-3.0).
- **Rejected voice:** the "alan" British voice is not used, because its source dataset is marked "All Rights Reserved".

## Listening

- **Wake word:** "Hey JARVIS" (openWakeWord) and "JARVIS" (sherpa-onnx keyword spotter), on the laptop.
- **Endpointing:** voice activity detection with an adaptive noise floor and hysteresis. JARVIS stops listening after a pause you can set (Settings → Microphone & speech; default 1.2 s, 1.8 s if you've said very little). Sensitivity is adjustable and can be calibrated.
- **Recognition:** NVIDIA Parakeet TDT 0.6B v2 on the laptop (free and private).
  - Before recognition the audio is cleaned: rumble removed, background gated (new in 6.8), silence trimmed, quiet speech normalised and the end padded.
  - A confidence estimate decides whether JARVIS asks you to repeat.
- **Background gate (6.8):** audio more than 12 dB below your own speaking level, such as a TV or other people further away, is turned down before recognition. Margins keep the start and end of your words intact. Measured: `docs/performance.md` → "JARVIS 6.8".
- **faster-whisper:** considered, not added.
  - On Windows it needs a separate Python runtime with CTranslate2.
  - On the earlier benchmark, Parakeet already made far fewer errors than Whisper base.
  - Larger Whisper models are slower on a laptop CPU.
  - Parakeet runs on the engine JARVIS already ships.
- **Microphone page:**
  - device choice (it refreshes when a microphone is plugged in or removed);
  - a live level meter with clipping warning and a live test;
  - noise suppression, echo cancellation and automatic gain;
  - calibration with a test sentence;
  - a live status line: microphone, state (standby / listening / in a conversation), recogniser and model, the last thing heard with its confidence and time, and any recognition error.

## Conversation

- **Session:** after "Hey JARVIS" you stay in a conversation. Follow-ups need no wake word until you're quiet for the timeout, or say "End conversation" / "Stop listening" / "Go back to standby".
- **Commands handled on the device (no AI round trip):**
  - "Stay with me", "Listen again", "Repeat that";
  - "Speak more slowly", "Speak faster", "Normal speed";
  - "Be brief" / "Keep it short", and "You can go into more detail";
  - "Wait" / "Hang on" / "Stop", which stop JARVIS and listen;
  - "Mute".
- **Interrupting:** say "JARVIS", "Wait…" or "Hold on…" while it's talking (laptop), tap the core or mic, or type.
  - Playback stops at once.
  - The AI request is cancelled on the server, so no further text is generated or paid for.
  - Only the part already produced is saved.
  - JARVIS is told how much you actually heard, so "Wait, explain that again" refers to the right thing.
  - "Wait" and "Hold on" only work while JARVIS is speaking in a conversation. They're ignored when JARVIS's own sentence contains a similar word (its own voice coming back through the speakers).
- **Context sent to Claude each turn:**
  - the last 20 messages (older ones as a running summary);
  - what JARVIS looked up for its recent replies (e.g. `get_weather(place=Larnaca)`), so "What about the weekend?" stays on the same subject;
  - any interruption;
  - "be brief" if you asked for it;
  - pending confirmations;
  - saved memories relevant to the message (not looked up for short remarks like "Brilliant").
- **Memory:** nothing from a conversation is saved as a memory unless you ask, or agree when JARVIS asks.
  - Summaries of long conversations stay with that conversation. From 6.8 they're only copied into long-term memory if you turn that on (Settings → Preferences).
  - Existing memories can be inspected, edited and deleted in Memory & Notes.

## Personality

- **Prompt:** describes JARVIS's manner and speaking style (`server/brain.js`, `PERSONA_BASE`), with tone illustrations it's told not to reuse. The truthfulness rules come first and are unchanged.
- **Form of address:** how often JARVIS says "Sir" (never / rarely / occasionally / often) is a setting. Each turn JARVIS is told when it has used it recently, so it stays occasional.
- **Openings:** JARVIS is shown how its recent replies began, so it doesn't open them all the same way.
- **Short spoken lines:** JARVIS's own lines ("Standing by", "I'm here", "I'll slow down"…) come from a varied set (`public/js/phrases.js`) and never repeat twice running.
- **Not tested:** prompt changes shape how Claude writes; they don't make the model more capable. They could only be tested here with a stand-in AI, so how natural the replies sound with your real Claude account hasn't been tested.
