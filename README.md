# callcompare

Sends the same call recording to **Deepgram (Nova-3)**, **AssemblyAI (Universal)**,
**Speechmatics (Enhanced)**, and **OpenAI (gpt-4o-transcribe-diarize)** at the same time,
diarizes all four, and writes a side-by-side comparison report — so you can see which tool
transcribes and separates speakers more accurately on your actual calls.

## What it does

1. Detects whether your audio file is mono or stereo with `ffprobe` (bundled binary, no system
   ffmpeg install required) and prints the channel info before sending anything to any API.
2. Fires all four transcription requests concurrently (`Promise.allSettled`), timing each one.
   - **Deepgram**: `model: nova-3`, `diarize_model: v2`, `language: en`, `punctuate: true`,
     `smart_format: true`, `numerals: true`, `utterances: true`, plus `multichannel: true` if
     the file is stereo, plus `keyterm` boosting if `--vocab`/`--vocab-file` is set.
   - **AssemblyAI**: `speech_models: [universal-3-pro, universal-2]`, `speaker_labels: true`,
     `speakers_expected` (see `--speakers` below), `language_code: en`, `punctuate: true`, plus
     `multichannel: true` if the file is stereo, plus `word_boost` (at `boost_param: high`) if
     `--vocab`/`--vocab-file` is set.
   - **Speechmatics**: `model: enhanced` (its highest-accuracy tier for single-language audio),
     `diarization: speaker`, plus `additional_vocab` if `--vocab`/`--vocab-file` is set.
   - **OpenAI**: `model: gpt-4o-transcribe-diarize`, `response_format: diarized_json`,
     `language: en`. Plain `whisper-1` has no diarization at all (just one blob of text, no
     speaker labels), so this uses OpenAI's newer diarization-capable transcription model
     instead — it's the only OpenAI model that returns per-speaker segments comparable to the
     other three providers. As a tradeoff it doesn't return word-level timestamps or confidence
     scores (those columns show as empty/`n/a`), and it has **no custom-vocabulary hook at all**
     (`prompt` is explicitly unsupported for this model) — `--vocab` has no effect on it; only
     `--corrections` (see below) can fix its mishearings.
3. Writes one file per provider plus a comparison report into `output/<audio-file-basename>/`
   (e.g. `output/my-call/`):
   - `deepgram_output.txt` — turn-by-turn `[start-end] Speaker A: text`
   - `assemblyai_output.txt` — same format, from AssemblyAI
   - `speechmatics_output.txt` — same format, from Speechmatics
   - `openai_output.txt` — same format, from OpenAI
   - `comparison_report.txt` — word counts, speaker counts, response time, average confidence,
     a word-level diff for every pair of providers, and any utterance where a pair disagrees by
     more than 30% of the words spoken (flagged as a "significant disagreement" with both
     versions shown side by side).

## 1. Install

```bash
cd callcompare
npm install
```

## 2. Add your API keys

```bash
cp .env.example .env
```

Edit `.env`:

```
DEEPGRAM_API_KEY=your_deepgram_api_key_here
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
SPEECHMATIC_API_KEY=your_speechmatics_api_key_here
WHISPER_API_KEY=your_openai_api_key_here
```

Get a Deepgram key at console.deepgram.com, an AssemblyAI key at assemblyai.com/app, a
Speechmatics key at portal.speechmatics.com, and an OpenAI key at platform.openai.com/api-keys
(make sure the account has billing/credit set up — a 429 "exceeded your current quota" error
means the key is valid but the account has no usable quota, not a bug in this tool).

## 3. Add your audio file

Drop your call recording into the `audio/` folder, e.g. `audio/my-call.wav`. Any format
ffprobe can read works (wav, mp3, m4a, etc.) — there's no sample file bundled, so you'll need
to supply a real recording to test against.

## 4. Run it

```bash
npm start -- ./audio/my-call.wav
```

You'll see the detected channel info printed immediately, then each provider's timing as it
finishes, then the five output files written to `output/`.

### Optional: naming speakers (Agent, Customer, IVR, ...)

Diarization tells you *how many* speakers there are and separates their turns, but each
provider assigns "Speaker A" / "Speaker B" / etc. independently — there's no guarantee
"Speaker A" means the same person across providers, and none of them know each speaker's
role. Some calls also have more than two speakers (e.g. a transfer to a second agent, or an
IVR/hold message playing before a human picks up).

Listen to each output file to figure out which letter is which, then re-run with a role map
per provider: `<letter>:<role>` pairs separated by commas.

```bash
npm start -- ./audio/my-call.wav \
  --deepgram-roles=A:Agent,B:Customer \
  --assemblyai-roles=A:Agent,B:Customer,C:IVR,D:Agent2 \
  --speechmatics-roles=A:Agent,B:Customer \
  --openai-roles=A:Agent,B:Customer
```

This relabels each mapped speaker's turns (e.g. `Agent:`, `Customer:`, `IVR:`) in that
provider's output file and notes the mapping used at the top of `comparison_report.txt`. Any
speaker letter you don't include stays as `Speaker X`. It's a manual per-call flag rather than
automatic guessing — call openings vary too much for a keyword heuristic to be reliable, so
this keeps you in control of who's who.

Other flags:

```bash
npm start -- ./audio/my-call.wav --out=./output/run-2   # custom base output directory
npm start -- ./audio/my-call.wav --speakers=3           # hint AssemblyAI's expected speaker count (default: 2)
```

`--out` sets the *base* output directory; a subfolder named after the audio file (e.g.
`run-2/my-call/`) is created inside it, so each call's output lands in its own folder and
re-running against different files never overwrites another call's results.

`--speakers` is passed to AssemblyAI as a hint for how many distinct speakers to expect, which
sharpens where it draws speaker boundaries (fewer mid-utterance mislabels). Defaults to 2
(agent + customer); raise it for calls you know involve a transfer, IVR, or conference.

### Tuning for higher accuracy

Every provider is already configured for its best available English transcription settings
(highest-accuracy model, punctuation/formatting, numerals, explicit language). Beyond that,
two more levers are worth using once you notice a *specific*, *recurring* mistake — general
audio quality (mono, 8kHz call recordings) still caps how far any of this can go, but domain
vocabulary mistakes are very fixable:

**1. `--vocab` / `--vocab-file`** — boosts recognition of terms the model doesn't already
know, *before* transcription runs. Best for proper nouns: company/product names, agent names,
street names. Applies natively to Deepgram (`keyterm`), AssemblyAI (`word_boost` at max
strength), and Speechmatics (`additional_vocab`). Has no effect on OpenAI (see above).

```bash
npm start -- ./audio/my-call.wav --vocab="Xfinity,T-Mobile,LendingMatch"
npm start -- ./audio/my-call.wav --vocab-file=./vocab.txt   # one term per line, "#" for comments
```

**2. `--corrections` / `--corrections-file`** — a universal find/replace pass applied to
*every* provider's output *after* transcription (whole-word, case-insensitive). Best for fixing
a mishearing you've already seen in the output and want gone everywhere, including on OpenAI,
which has no other lever available.

```bash
npm start -- ./audio/my-call.wav --corrections="10Q=>Thank you,youtube.com=>xfinity.com"
npm start -- ./audio/my-call.wav --corrections-file=./corrections.txt   # one "from=>to" pair per line
```

Practical workflow: run once with no tuning, read `comparison_report.txt` for disagreements
and skim each `*_output.txt`, note any proper nouns or recurring mishearings, then re-run with
`--vocab` for the proper nouns and `--corrections` for anything vocab boosting doesn't fully
fix (short acronyms, homophones, things OpenAI still gets wrong). Both flags are additive across
runs, so a `vocab.txt`/`corrections.txt` pair built up over a few calls keeps paying off on
every later call from the same business.

## Project structure

```
callcompare/
  src/
    config.ts               # loads + validates the four provider API keys from .env
    audioInfo.ts             # ffprobe-based mono/stereo detection
    types.ts                  # shared normalized result types
    providers/
      deepgram.ts             # Nova-3 transcription + diarization, normalized to common shape
      assemblyai.ts            # Universal transcription + diarization, normalized to common shape
      speechmatics.ts          # Enhanced transcription + diarization, normalized to common shape
      openai.ts                # gpt-4o-transcribe-diarize, normalized to common shape
    compare.ts                # word-level diff + utterance-level disagreement, all provider pairs
    report.ts                 # writes the per-provider + comparison .txt files
    vocabulary.ts              # --vocab / --vocab-file loading for native vocab boosting
    corrections.ts             # --corrections / --corrections-file post-processing find/replace
    index.ts                  # CLI entry point — wires everything together
  audio/                     # put your test recording(s) here
  output/
    <call-name>/             # one subfolder per audio file, holding its .txt outputs
  .env.example
```

## Notes on accuracy

- Word-level and disagreement diffs are computed after lowercasing and stripping punctuation,
  so formatting differences (casing, commas) don't count as disagreements — only actual wording
  differences do.
- Disagreement segments are found by aligning each provider's utterances to whichever other
  provider's utterance(s) overlap it in time (providers don't segment turns identically), then
  comparing the words spoken in that time window. This is done for every pair of providers.
- If your file is stereo with one speaker cleanly on each channel (a common setup for call
  center recordings — agent on one line, customer on the other), `multichannel: true` is enabled
  automatically alongside diarization for Deepgram and AssemblyAI, which usually gives more
  reliable speaker separation than diarization alone on a single mixed-down channel.
- Mono, low-sample-rate (e.g. 8kHz) call recordings inherently cap diarization accuracy for all
  four providers, since there's no separate channel per speaker to fall back on — expect
  occasional mid-utterance speaker mislabels during fast back-and-forth, no matter how well
  tuned the settings are.
