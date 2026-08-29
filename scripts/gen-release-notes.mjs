#!/usr/bin/env node
/**
 * Extract one version's bilingual release notes from CHANGELOG.md.
 *
 * CHANGELOG format (mirrors DSH-APP): `## [vX.Y.Z] - YYYY-MM-DD` headings with
 * `### 中文` and `### English` sub-sections. The script prints the
 * release-body markdown for the given tag: a title, the two detail blocks and
 * the installer footer. Exits non-zero when the tag has no section yet — the
 * release workflow treats that as a broken changelog, not an empty one.
 *
 * Usage: node scripts/gen-release-notes.mjs v0.1.0
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tag = process.argv[2]
if (!tag || !/^v\d/.test(tag)) {
  console.error('usage: node scripts/gen-release-notes.mjs <vX.Y.Z>')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

const sectionRe = /^## \[(.+?)\].*$/gm
const sections = []
for (const match of changelog.matchAll(sectionRe)) {
  sections.push({ version: match[1], start: match.index })
}
for (let i = 0; i < sections.length; i++) {
  sections[i].end = i + 1 < sections.length ? sections[i + 1].start : changelog.length
}

const section = sections.find((s) => s.version === tag)
if (!section) {
  console.error(`CHANGELOG.md has no "## [${tag}]" section. Add one before tagging.`)
  process.exit(1)
}

const body = changelog.slice(section.start, section.end)
const grab = (heading) => {
  const re = new RegExp(`### ${heading}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`)
  return re.exec(body)?.[1].trim() ?? ''
}
const zh = grab('中文')
const en = grab('English')
if (!zh || !en) {
  console.error(`Section [${tag}] must contain both "### 中文" and "### English" blocks.`)
  process.exit(1)
}

console.log(`## 🚀 Coding Usage ${tag} 更新说明 / Release Notes

<details open><summary>🇨🇳 中文</summary>

${zh}

</details>

<details><summary>🇬🇧 English</summary>

${en}

</details>

---
安装包见下方 Release 附件（Windows）。
Installers are attached below (Windows).
`)
