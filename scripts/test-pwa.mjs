import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sourceFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(path)
  }
  return files
}

const manifestPath = 'public/manifest.webmanifest'
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

assert.equal(manifest.name, 'Paper Collector')
assert.equal(manifest.short_name, 'Papers')
assert.equal(manifest.id, '/')
assert.equal(manifest.start_url, '/')
assert.equal(manifest.scope, '/')
assert.equal(manifest.display, 'standalone')
assert.equal(manifest.background_color, '#f6f4ef')
assert.equal(manifest.theme_color, '#f6f4ef')
assert.equal(manifest.prefer_related_applications, false)
assert(Array.isArray(manifest.icons), 'Manifest icons must be an array')

const icon192 = manifest.icons.find((icon) => icon.sizes?.split(/\s+/).includes('192x192'))
const icon512 = manifest.icons.find((icon) => icon.sizes?.split(/\s+/).includes('512x512'))
assert(icon192, 'Manifest must declare a 192x192 icon')
assert(icon512, 'Manifest must declare a 512x512 icon')
assert.equal(icon192.type, 'image/svg+xml')
assert.equal(icon512.type, 'image/svg+xml')
assert(icon512.purpose?.split(/\s+/).includes('maskable'), '512 icon must be maskable-safe')
assert(icon512.purpose?.split(/\s+/).includes('any'), '512 icon must remain usable as a normal iOS manifest icon')

for (const icon of [icon192, icon512]) {
  const relativePath = `public${icon.src}`
  assert(await exists(relativePath), `Manifest icon is missing: ${relativePath}`)
  const svg = await readFile(relativePath, 'utf8')
  assert(svg.includes('<svg'), `${relativePath} is not SVG markup`)
  assert(svg.includes('fill="#315f4e"'), `${relativePath} does not contain the full-bleed app background`)
}

const html = await readFile('index.html', 'utf8')
assert(/rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/.test(html), 'index.html does not link the manifest')
assert(html.includes('name="apple-mobile-web-app-capable" content="yes"'), 'iPhone standalone capability meta is missing')
assert(html.includes('name="apple-mobile-web-app-status-bar-style" content="default"'), 'iPhone status bar metadata is missing')
assert(html.includes('name="apple-mobile-web-app-title" content="Paper Collector"'), 'iPhone Home Screen title metadata is missing')
assert(!/rel=["']apple-touch-icon["']/.test(html), 'apple-touch-icon would override the shared manifest icon contract')

const files = await sourceFiles('src')
const source = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n')
assert(!source.includes('navigator.serviceWorker'), 'Service Worker registration was added without an offline-state contract')
assert(!source.includes('serviceWorker.register'), 'Service Worker registration was added without an offline-state contract')

assert(await exists('dist/manifest.webmanifest'), 'Vite build did not copy the web app manifest to dist')
assert(await exists('dist/icon-192.svg'), 'Vite build did not copy the 192 icon to dist')
assert(await exists('dist/icon-512.svg'), 'Vite build did not copy the 512 icon to dist')

const builtManifest = JSON.parse(await readFile('dist/manifest.webmanifest', 'utf8'))
assert.deepEqual(builtManifest, manifest, 'Built manifest differs from the checked source manifest')
const builtHtml = await readFile('dist/index.html', 'utf8')
assert(builtHtml.includes('/manifest.webmanifest'), 'Built HTML lost the manifest link')

console.log('PWA installability checks passed: manifest, 192/512 icons, iPhone standalone metadata, build output, and no false offline service worker verified.')
