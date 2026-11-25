/**
 * dsh-screen-record — Host half.
 *
 * Gives the agent three real tools on this Windows machine:
 *   screen_record          record the desktop for N seconds and return an MP4 path (+ poster PNG)
 *   screen_record_control  start / stop / status long recordings
 *   screenshot             grab one PNG frame of the desktop (or a region / window)
 *
 * Everything is done by a local ffmpeg binary (gdigrab input). No native module,
 * no install script, no build step: the plugin is plain ESM plus a child process.
 *
 * ffmpeg lookup order:
 *   1. `ffmpeg` argument of the tool call, when the caller passes an explicit path
 *   2. DSH_FFMPEG_PATH environment variable
 *   3. <this package>/bin/ffmpeg.exe
 *   4. %USERPROFILE%/.dsh/screen-recorder/bin/ffmpeg.exe
 *   5. ffmpeg on PATH
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(os.homedir(), '.dsh', 'screen-recorder')
const defaultOutDir = path.join(dataDir, 'recordings')

const MAX_DURATION = 600
const RESOLVE_CACHE = { ffmpeg: undefined, ffprobe: undefined, encoder: undefined }
const active = new Map()

/* ------------------------------------------------------------------ helpers */

function normalizeArgs(args) {
  return args && typeof args === 'object' ? args : {}
}

async function isFile(candidate) {
  try {
    const info = await fsp.stat(candidate)
    return info.isFile()
  } catch {
    return false
  }
}

function candidates(name) {
  const file = process.platform === 'win32' ? `${name}.exe` : name
  const list = []
  if (process.env.DSH_FFMPEG_PATH && name === 'ffmpeg') {
    const envPath = process.env.DSH_FFMPEG_PATH
    list.push(path.join(path.dirname(envPath), file))
    list.push(envPath)
  }
  list.push(path.join(here, 'bin', file))
  list.push(path.join(dataDir, 'bin', file))
  list.push(file)
  return list
}

async function resolveBinary(name, explicit) {
  if (explicit) {
    if (await isFile(explicit)) return explicit
    throw new Error(`screen_record: ffmpeg path does not exist: ${explicit}`)
  }
  if (RESOLVE_CACHE[name]) return RESOLVE_CACHE[name]
  for (const candidate of candidates(name)) {
    if (candidate === `${name}.exe` || candidate === name) {
      // bare name: trust PATH, validated by the first real invocation
      RESOLVE_CACHE[name] = candidate
      return candidate
    }
    if (await isFile(candidate)) {
      RESOLVE_CACHE[name] = candidate
      return candidate
    }
  }
  return undefined
}

async function requireFfmpeg(explicit) {
  const ffmpeg = await resolveBinary('ffmpeg', explicit)
  if (!ffmpeg) {
    throw new Error(
      'screen_record: ffmpeg was not found. Expected %USERPROFILE%\\.dsh\\screen-recorder\\bin\\ffmpeg.exe, '
      + 'the plugin bin/ folder, or ffmpeg on PATH.',
    )
  }
  return ffmpeg
}

function runProcess(file, argv, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`screen_record: ${path.basename(file)} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })

    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

async function detectEncoder(ffmpeg) {
  if (RESOLVE_CACHE.encoder) return RESOLVE_CACHE.encoder
  let encoder = 'mpeg4'
  try {
    const result = await runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 20_000 })
    if (/libx264/.test(result.stdout) || /libx264/.test(result.stderr)) encoder = 'libx264'
  } catch {
    // keep the conservative fallback
  }
  RESOLVE_CACHE.encoder = encoder
  return encoder
}

function encoderArgs(encoder) {
  if (encoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']
  }
  return ['-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p']
}

function parseRegion(region) {
  const text = typeof region === 'string' ? region.trim() : ''
  if (!text || text === 'full' || text === 'desktop') return { kind: 'desktop' }
  const windowMatch = text.match(/^(?:title=|win:)(.+)$/i)
  if (windowMatch) return { kind: 'title', title: windowMatch[1].trim() }
  const match = text.match(/^(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)$/)
  if (!match) {
    throw new Error(`screen_record: region must be "full", "title=<window title>" or "x,y,width,height" (got "${text}")`)
  }
  const [, x, y, w, h] = match
  if (Number(x) < 0 || Number(y) < 0) {
    throw new Error('screen_record: region x/y must not be negative')
  }
  if (Number(w) < 16 || Number(h) < 16) {
    throw new Error('screen_record: region width/height must be at least 16 px')
  }
  return { kind: 'region', x: Number(x), y: Number(y), w: Number(w), h: Number(h) }
}

function videoInput(region, fps, drawMouse) {
  const base = ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', drawMouse ? '1' : '0']
  if (region.kind === 'title') return [...base, '-i', `title=${region.title}`]
  if (region.kind === 'region') {
    return [
      ...base,
      '-offset_x', String(region.x),
      '-offset_y', String(region.y),
      '-video_size', `${region.w}x${region.h}`,
      '-i', 'desktop',
    ]
  }
  return [...base, '-i', 'desktop']
}

async function detectAudioDevice(ffmpeg) {
  const result = await runProcess(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    timeoutMs: 20_000,
  })
  const text = `${result.stderr}\n${result.stdout}`
  const matches = [...text.matchAll(/"([^"]+)"\s*\(audio\)/g)].map((m) => m[1])
  return matches
}

async function resolveAudio(ffmpeg, audio) {
  if (audio === undefined || audio === false || audio === 'none' || audio === '') return undefined
  if (audio === true) {
    const devices = await detectAudioDevice(ffmpeg)
    if (!devices.length) {
      throw new Error('screen_record: audio:true was requested but ffmpeg found no DirectShow audio device')
    }
    return devices[0]
  }
  return String(audio)
}

async function probeMedia(ffprobe, file) {
  if (!ffprobe) return {}
  try {
    const result = await runProcess(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration,size', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file],
      { timeoutMs: 20_000 },
    )
    if (result.code !== 0) return {}
    const parsed = JSON.parse(result.stdout || '{}')
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
    return {
      durationSec: parsed.format?.duration ? Number(Number(parsed.format.duration).toFixed(2)) : undefined,
      bytes: parsed.format?.size ? Number(parsed.format.size) : undefined,
      width: stream?.width,
      height: stream?.height,
      codec: stream?.codec_name,
    }
  } catch {
    return {}
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function resolveOutput(output, ext) {
  if (output) {
    const target = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output)
    return target.toLowerCase().endsWith(ext) ? target : `${target}${ext}`
  }
  return path.join(defaultOutDir, `record-${timestamp()}${ext}`)
}

async function writePoster(ffmpeg, videoPath, atSecond) {
  const poster = videoPath.replace(/\.mp4$/i, '') + '.poster.png'
  const seek = atSecond >= 1 ? ['-ss', String(Math.min(atSecond, 3))] : []
  const result = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...seek, '-i', videoPath, '-frames:v', '1', poster], {
    timeoutMs: 30_000,
  })
  return result.code === 0 ? poster : undefined
}

async function fileSize(file) {
  try {
    const info = await fsp.stat(file)
    return info.size
  } catch {
    return undefined
  }
}

/* --------------------------------------------------------------- recording */

async function recordOnce(options) {
  const {
    ffmpeg, duration, fps, region, drawMouse, scale, audio, output,
  } = options

  const encoder = await detectEncoder(ffmpeg)
  const target = resolveOutput(output, '.mp4')
  await ensureDir(path.dirname(target))

  const audioDevice = await resolveAudio(ffmpeg, audio)
  const filters = []
  if (scale) filters.push(`scale=${scale}:-2`)
  else filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')

  const argv = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...videoInput(region, fps, drawMouse),
    ...(audioDevice ? ['-f', 'dshow', '-i', `audio=${audioDevice}`] : []),
    '-t', String(duration),
    ...encoderArgs(encoder),
    ...(audioDevice ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-vf', filters.join(','),
    '-movflags', '+faststart',
    target,
  ]

  const started = Date.now()
  const result = await runProcess(ffmpeg, argv, { timeoutMs: (duration + 45) * 1000 })
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-4).join(' | ')
    throw new Error(`screen_record: ffmpeg exited with ${result.code}${tail ? `: ${tail}` : ''}`)
  }

  const ffprobe = await resolveBinary('ffprobe')
  const probed = await probeMedia(ffprobe, target)
  const bytes = probed.bytes ?? (await fileSize(target))
  if (!bytes) throw new Error(`screen_record: ffmpeg reported success but no file was written to ${target}`)

  const poster = await writePoster(ffmpeg, target, probed.durationSec ?? 0)

  return {
    ok: true,
    path: target,
    poster,
    durationSec: probed.durationSec ?? Number(((Date.now() - started) / 1000).toFixed(1)),
    bytes,
    width: probed.width,
    height: probed.height,
    codec: probed.codec ?? encoder,
    fps,
    region: region.kind === 'desktop' ? 'full desktop' : region.kind === 'title' ? `window "${region.title}"` : `${region.x},${region.y} ${region.w}x${region.h}`,
    audio: audioDevice ?? null,
    elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
  }
}

function startRecording(options) {
  const {
    ffmpeg, fps, region, drawMouse, scale, output, audioDevice,
  } = options
  return new Promise((resolve, reject) => {
    const target = resolveOutput(output, '.mp4')
    const argv = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...videoInput(region, fps, drawMouse),
      ...(audioDevice ? ['-f', 'dshow', '-i', `audio=${audioDevice}`] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      ...(audioDevice ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-vf', scale ? `scale=${scale}:-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      target,
    ]

    const child = spawn(ffmpeg, argv, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let failed = false

    child.stderr.on('data', (chunk) => { stderr += String(chunk) })

    const readyTimer = setTimeout(() => {
      if (failed) return
      const id = `rec-${Date.now().toString(36)}`
      active.set(id, {
        id, child, path: target, startedAt: new Date().toISOString(), stderr: () => stderr,
      })
      resolve({ id, path: target })
    }, 1200)

    child.on('error', (error) => {
      failed = true
      clearTimeout(readyTimer)
      reject(error)
    })
    child.on('close', (code) => {
      failed = true
      clearTimeout(readyTimer)
      if (code !== 0) {
        for (const [id, entry] of active) {
          if (entry.child === child) active.delete(id)
        }
        reject(new Error(`screen_record_control: ffmpeg stopped early with ${code}${stderr ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''}`))
      }
    })
  })
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    child.once('close', (code) => finish({ code }))
    setTimeout(() => finish({ timedOut: true }), timeoutMs)
  })
}

async function stopRecording(id) {
  const entry = active.get(id) ?? [...active.values()].at(-1)
  if (!entry) throw new Error('screen_record_control: no recording is running')
  const { child, path: target } = entry
  try {
    child.stdin.write('q')
  } catch {
    // stdin already closed; fall through to the timeout path
  }
  const exited = await waitExit(child, 20_000)
  if (exited.timedOut) {
    child.kill()
    await waitExit(child, 5_000)
  }
  active.delete(entry.id)

  const bytes = await fileSize(target)
  const ffmpeg = await requireFfmpeg()
  const ffprobe = await resolveBinary('ffprobe')
  const probed = bytes ? await probeMedia(ffprobe, target) : {}
  if (!bytes) throw new Error(`screen_record_control: recording ended but ${target} is missing or empty`)
  const poster = await writePoster(ffmpeg, target, probed.durationSec ?? 0)

  return {
    ok: true,
    path: target,
    poster,
    durationSec: probed.durationSec,
    bytes,
    width: probed.width,
    height: probed.height,
    codec: probed.codec,
    stoppedCleanly: !exited.timedOut,
    startedAt: entry.startedAt,
  }
}

/* ------------------------------------------------------------- screenshot */

async function captureScreenshot(options) {
  const {
    ffmpeg, region, output, scale,
  } = options
  const target = resolveOutput(output, '.png')
  await ensureDir(path.dirname(target))

  const argv = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...videoInput(region, 1, true),
    '-frames:v', '1',
    ...(scale ? ['-vf', `scale=${scale}:-2`] : []),
    target,
  ]
  const result = await runProcess(ffmpeg, argv, { timeoutMs: 60_000 })
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
    throw new Error(`screenshot: ffmpeg exited with ${result.code}${tail ? `: ${tail}` : ''}`)
  }
  const bytes = await fileSize(target)
  if (!bytes) throw new Error(`screenshot: no image was written to ${target}`)
  return { ok: true, path: target, bytes }
}

/* ------------------------------------------------------------- text output */

function fmtBytes(bytes) {
  if (!bytes) return 'unknown size'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function describeRecording(value) {
  if (!value?.path) return 'screen_record finished without a file.'
  const size = value.width && value.height ? `${value.width}x${value.height}` : 'resolution unknown'
  const duration = value.durationSec !== undefined ? `${value.durationSec}s` : 'duration unknown'
  return [
    `Recording saved · ${duration} · ${size} · ${fmtBytes(value.bytes)}`,
    `file: ${value.path}`,
    value.poster ? `poster: ${value.poster}` : undefined,
  ].filter(Boolean).join('\n')
}

function describeControl(value) {
  if (value.action === 'status') {
    if (!value.recordings?.length) return 'No recording is running.'
    return value.recordings.map((item) => `· ${item.id} → ${item.path} (since ${item.startedAt})`).join('\n')
  }
  if (value.action === 'start') {
    return `Recording started · id ${value.id}\nfile: ${value.path}\nCall screen_record_control with action="stop" (and this id) when done.`
  }
  return describeRecording(value)
}

const RECORD_DESCRIPTION = [
  'Record this Windows desktop with a local ffmpeg (gdigrab) and return the finished MP4 path.',
  'Use it when the user asks to record the screen, capture a demo, or produce a video of what is happening on the machine.',
  'duration is in seconds (default 10, max 600); a longer session should use screen_record_control with start then stop.',
  'region accepts "full" (default), "title=<window title>" to capture one window, or "x,y,width,height" for a rectangle.',
  'audio is off by default; pass true to auto-pick the first DirectShow audio device or a device name string.',
  'The call blocks until the clip is written, then returns path, poster (first-frame PNG), duration, size and resolution.',
].join(' ')

const SCREENSHOT_DESCRIPTION = [
  'Capture one PNG frame of this Windows desktop with ffmpeg and return its path.',
  'Use it to look at what is currently on screen, or to attach a screenshot to the reply.',
  'region accepts "full" (default), "title=<window title>" or "x,y,width,height".',
].join(' ')

/* ------------------------------------------------------------------ plugin */

export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'screen_record',
      description: RECORD_DESCRIPTION,
      timeoutMs: 900_000,
      parameters: {
        type: 'object',
        properties: {
          duration: {
            type: 'number',
            description: `Recording length in seconds (1-${MAX_DURATION}). Default 10.`,
          },
          fps: { type: 'number', description: 'Frames per second, 5-30. Default 15.' },
          region: {
            type: 'string',
            description: 'full (default) | title=<window title> | x,y,width,height',
          },
          audio: {
            description: 'false (default) | true to auto-pick a DirectShow audio device | a device name string.',
          },
          scale: { type: 'number', description: 'Optional output width in pixels; height keeps the aspect ratio.' },
          drawMouse: { type: 'boolean', description: 'Draw the mouse cursor into the video. Default true.' },
          output: { type: 'string', description: 'Optional output .mp4 path (absolute, or relative to the cwd).' },
          ffmpeg: { type: 'string', description: 'Optional explicit ffmpeg.exe path; normally auto-detected.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            poster: { type: 'string' },
            durationSec: { type: 'number' },
            bytes: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            codec: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: describeRecording(value ?? {}) }],
      },
      async execute(rawArgs) {
        if (process.platform !== 'win32') throw new Error('screen_record: only Windows is supported')
        const args = normalizeArgs(rawArgs)
        const duration = Math.min(Math.max(Number(args.duration ?? 10) || 10, 1), MAX_DURATION)
        const fps = Math.min(Math.max(Number(args.fps ?? 15) || 15, 5), 30)
        if (Number(args.duration) > MAX_DURATION) {
          throw new Error(`screen_record: duration is capped at ${MAX_DURATION}s; use screen_record_control start/stop for longer sessions`)
        }
        const ffmpeg = await requireFfmpeg(args.ffmpeg)
        return recordOnce({
          ffmpeg,
          duration,
          fps,
          region: parseRegion(args.region),
          drawMouse: args.drawMouse !== false,
          scale: args.scale ? Number(args.scale) : undefined,
          audio: args.audio,
          output: args.output,
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'screen_record_control',
      description: [
        'Long screen recordings: action="start" begins recording the desktop in the background and returns an id,',
        'action="stop" finalizes it (pass the id; defaults to the most recent) and returns the MP4 path plus a poster PNG,',
        'action="status" lists running recordings.',
        'Use screen_record instead when you already know how long the clip should be.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status'],
            description: 'start = begin a background recording; stop = finalize and return the file; status = list running recordings.',
          },
          id: { type: 'string', description: 'Recording id from action="start" (stop only; defaults to the latest).' },
          fps: { type: 'number', description: 'start only: frames per second, 5-30. Default 15.' },
          region: { type: 'string', description: 'start only: full (default) | title=<window title> | x,y,width,height.' },
          audio: {
            description: 'start only: false (default) | true to auto-pick a DirectShow audio device | a device name string.',
          },
          scale: { type: 'number', description: 'start only: optional output width in pixels.' },
          drawMouse: { type: 'boolean', description: 'start only: draw the mouse cursor. Default true.' },
          output: { type: 'string', description: 'start only: optional output .mp4 path.' },
          ffmpeg: { type: 'string', description: 'start only: optional explicit ffmpeg.exe path.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            id: { type: 'string' },
            path: { type: 'string' },
            poster: { type: 'string' },
            durationSec: { type: 'number' },
            bytes: { type: 'number' },
            recordings: { type: 'array' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: describeControl(value ?? {}) }],
      },
      async execute(rawArgs) {
        if (process.platform !== 'win32') throw new Error('screen_record_control: only Windows is supported')
        const args = normalizeArgs(rawArgs)
        const action = args.action

        if (action === 'status') {
          return {
            ok: true,
            action,
            recordings: [...active.values()].map((entry) => ({
              id: entry.id, path: entry.path, startedAt: entry.startedAt,
            })),
          }
        }

        if (action === 'start') {
          const ffmpeg = await requireFfmpeg(args.ffmpeg)
          const fps = Math.min(Math.max(Number(args.fps ?? 15) || 15, 5), 30)
          const region = parseRegion(args.region)
          const audioDevice = await resolveAudio(ffmpeg, args.audio)
          const output = resolveOutput(args.output, '.mp4')
          await ensureDir(path.dirname(output))
          const started = await startRecording({
            ffmpeg,
            fps,
            region,
            drawMouse: args.drawMouse !== false,
            scale: args.scale ? Number(args.scale) : undefined,
            output,
            audioDevice,
          })
          return { ok: true, action, id: started.id, path: started.path }
        }

        if (action === 'stop') {
          const value = await stopRecording(args.id)
          return { ...value, action }
        }

        throw new Error(`screen_record_control: unknown action "${String(action)}"`)
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'screenshot',
      description: SCREENSHOT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            description: 'full (default) | title=<window title> | x,y,width,height',
          },
          scale: { type: 'number', description: 'Optional output width in pixels.' },
          output: { type: 'string', description: 'Optional output .png path.' },
          ffmpeg: { type: 'string', description: 'Optional explicit ffmpeg.exe path.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            bytes: { type: 'number' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Screenshot saved · ${fmtBytes(value?.bytes)}\nfile: ${value?.path ?? '(missing)'}\nRead it with the read_image tool when you need to see it.`,
        }],
      },
      async execute(rawArgs) {
        if (process.platform !== 'win32') throw new Error('screenshot: only Windows is supported')
        const args = normalizeArgs(rawArgs)
        const ffmpeg = await requireFfmpeg(args.ffmpeg)
        return captureScreenshot({
          ffmpeg,
          region: parseRegion(args.region),
          scale: args.scale ? Number(args.scale) : undefined,
          output: args.output,
        })
      },
    }),
  )

  ctx.effect(() => () => {
    for (const entry of active.values()) {
      try {
        entry.child.kill()
      } catch {
        // already gone
      }
    }
    active.clear()
  })
}
