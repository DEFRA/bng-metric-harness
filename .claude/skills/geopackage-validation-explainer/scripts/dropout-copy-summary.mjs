/**
 * What check-dropout-copy.mjs found, written for whoever opens the run: a
 * product owner, a BA or a content designer as much as a developer. GitHub
 * shows it on the run's page (the job summary), so nobody has to read a log.
 *
 * Markdown, as job summaries render GitHub-flavoured Markdown: a verdict,
 * what it means for users, a table for each kind of problem, and what to do.
 */

const BACKEND_REPO_URL = 'https://github.com/DEFRA/bng-metric-backend'
const FRONTEND_REPO_URL = 'https://github.com/DEFRA/bng-metric-frontend'
const SHORT_COMMIT_LENGTH = 7
// The backend's description of a rule, cut to what a table cell can hold.
const MAX_DESCRIPTION_LENGTH = 280

/** Text for a Markdown table cell: one line, no column breaks. */
function cell(text) {
  return String(text ?? '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll('|', '\\|')
    .trim()
}

// A backend doc comment's opening sentences, which say what the rule checks;
// the rest is usually for developers.
const OPENING_SENTENCES = 2

function shorten(text) {
  const opening = (text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text])
    .slice(0, OPENING_SENTENCES)
    .join('')
    .trim()
  return opening.length > MAX_DESCRIPTION_LENGTH
    ? `${opening.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
    : opening
}

/** A link to `file` in `repoUrl` at the commit compared, or plain text. */
function fileLink(repoUrl, commit, file, line) {
  const label = line ? `${file}:${line}` : file
  if (!commit) {
    return `\`${label}\``
  }
  const anchor = line ? `#L${line}` : ''
  return `[\`${label}\`](${repoUrl}/blob/${commit}/${file}${anchor})`
}

function versionLine(label, repoUrl, provenance) {
  const commit = provenance?.commit
  if (!commit) {
    return `${label}: unknown commit`
  }
  const short = commit.slice(0, SHORT_COMMIT_LENGTH)
  const branch = provenance.branch ? `\`${provenance.branch}\` at ` : ''
  return `${label}: ${branch}[\`${short}\`](${repoUrl}/commit/${commit})`
}

/**
 * What a missing code checks: the validation explainer's plain-English text
 * where it has one, else the opening of the backend's own description.
 */
function describe(code, rules) {
  const rule = rules[code] ?? {}
  if (rule.plain) {
    return cell(rule.plain)
  }
  const site = rule.raisedAt?.find((s) => s.message) ?? rule.raisedAt?.[0]
  const text =
    rule.description || site?.message || 'No description in the backend.'
  return shorten(cell(text))
}

function raisedIn(code, rules, commit) {
  const sites = rules[code]?.raisedAt ?? []
  if (sites.length === 0) {
    return 'Not raised anywhere yet'
  }
  return sites
    .map((s) => fileLink(BACKEND_REPO_URL, commit, s.file, s.line))
    .join('<br>')
}

const NEW_ENTRY_TEMPLATE = (code) => `  ${code}:
    whenAlone:
      title:
        - Your Geopackage (.gpkg) file contains an error
      body: >-
        Say what is wrong with the file, and how to put it right, then
        [upload a new file](upload).
    inList: service-message`

const STOPGAP_TEMPLATE = (code) => `  ${code}:
    whenAlone: catch-all
    inList: service-message`

const NEW_MARK = '🆕'

/**
 * A note for errors the validation explainer has not classified: one may
 * refuse a change made on screen rather than an upload, and need no wording.
 */
function unclassifiedNote(unclassified) {
  if (unclassified.length === 0) {
    return []
  }
  const one = unclassified.length === 1
  return [
    `> **Check first:** **${one ? 'One of these errors is' : `${unclassified.length} of these errors are`} new to the validation explainer** (marked ${NEW_MARK}), so this check cannot yet tell whether ${one ? 'it refuses' : 'each refuses'} an uploaded file or a change made on screen. An error for a change made on screen never reaches the drop-out page, and needs no wording. Before anyone writes wording for ${one ? 'it' : 'them'}, a developer should run \`/geopackage-validation-explainer\` in bng-metric-harness to classify ${one ? 'it' : 'them'}. If ${one ? 'it is' : 'one is'} an on-screen error, this check stops asking for ${one ? 'it' : 'that one'}.`,
    ''
  ]
}

function missingSection(missing, rules, context) {
  const unclassified = missing.filter((code) => rules[code]?.unclassified)
  const rows = missing.map((code) => {
    const mark = unclassified.includes(code) ? ` ${NEW_MARK}` : ''
    return `| \`${code}\`${mark} | ${describe(code, rules)} | ${raisedIn(code, rules, context.backend?.commit)} |`
  })
  const [first] = missing
  return [
    `### ${missing.length} upload error${missing.length === 1 ? '' : 's'} with no wording on the drop-out page`,
    '',
    'A user whose file is refused for one of these sees the **generic message** ("Your Geopackage (.gpkg) file contains an error", then advice about layer and column names that may have nothing to do with the problem) or the service\'s technical message. Neither tells them what is wrong with their file.',
    '',
    '| Error | What the service checks | Where the backend raises it |',
    '| --- | --- | --- |',
    ...rows,
    '',
    ...unclassifiedNote(unclassified),
    '**What to do**',
    '',
    `1. Agree the wording for each error with a content designer or BA. The table says what each one checks.${unclassified.length > 0 ? ` For an error marked ${NEW_MARK}, classify it first, as above.` : ''}`,
    `2. Add an entry for each to ${context.copyFileLink} in bng-metric-frontend, by pull request. The file's header explains each field.`,
    '3. The check passes again on its next run once that pull request is merged.',
    '',
    '<details><summary>An entry to start from</summary>',
    '',
    '```yaml',
    NEW_ENTRY_TEMPLATE(first),
    '```',
    '',
    'If the wording is not ready yet, a stop-gap entry makes the check pass, but users still see the generic message:',
    '',
    '```yaml',
    STOPGAP_TEMPLATE(first),
    '```',
    '',
    '</details>',
    ''
  ]
}

function staleSection(stale, context) {
  return [
    `### ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} for errors the service no longer has`,
    '',
    'No user can see this wording, as the backend no longer raises these errors. It does no harm to users, but it is wording nobody reviews.',
    '',
    '| Entry in the drop-out page wording |',
    '| --- |',
    ...stale.map((code) => `| \`${code}\` |`),
    '',
    '**What to do**',
    '',
    `- If the backend renamed the error, move the wording to the entry for its new name in ${context.copyFileLink}.`,
    '- Otherwise, delete the entry, by pull request to bng-metric-frontend.',
    ''
  ]
}

const EDIT_PLACEHOLDER_TEMPLATE = (code) => `  ${code}: placeholder`

const EDIT_ENTRY_TEMPLATE = (code) => `  ${code}:
    summary: Say what is wrong, for the error summary at the top of the page.
    inline: Say how to put it right, by the field.`

function editSection(edit, context) {
  const lines = []
  if (edit.missing.length > 0) {
    const n = edit.missing.length
    const [first] = edit.missing
    lines.push(
      `### ${n} on-screen error${n === 1 ? '' : 's'} with no entry in the edit section`,
      '',
      `${n === 1 ? 'This error refuses' : 'These errors refuse'} a change a user makes to a habitat on screen, after their file was accepted. Without an entry, the page cannot show its own message.`,
      '',
      '| Error |',
      '| --- |',
      ...edit.missing.map((code) => `| \`${code}\` |`),
      '',
      '**What to do**',
      '',
      `- Add an entry for each under \`edit:\` in ${context.copyFileLink}, by pull request to bng-metric-frontend: wording agreed with a content designer, or \`placeholder\` until it is.`,
      '',
      '<details><summary>An entry to start from</summary>',
      '',
      '```yaml',
      EDIT_ENTRY_TEMPLATE(first),
      '```',
      '',
      'Or, until the wording is agreed:',
      '',
      '```yaml',
      EDIT_PLACEHOLDER_TEMPLATE(first),
      '```',
      '',
      '</details>',
      ''
    )
  }
  if (edit.stale.length > 0) {
    lines.push(
      `### ${edit.stale.length} entr${edit.stale.length === 1 ? 'y' : 'ies'} in the edit section for errors that refuse no edit`,
      '',
      '| Entry |',
      '| --- |',
      ...edit.stale.map((code) => `| \`${code}\` |`),
      '',
      '**What to do**',
      '',
      `- If the error was renamed, move the entry to its new name. If it only refuses uploads, its wording belongs under \`upload:\`. Otherwise, delete it.`,
      ''
    )
  }
  return lines
}

function footer(context) {
  return [
    '---',
    '',
    'When the service refuses an uploaded GeoPackage, it shows the user a drop-out page saying what is wrong. The backend decides *which* error it is; the frontend\'s drop-out page wording says *how* it is explained. Neither repository\'s own checks can see the other, so this check compares them.',
    '',
    `Compared — ${versionLine('backend', BACKEND_REPO_URL, context.backend)} · ${versionLine('frontend', FRONTEND_REPO_URL, context.frontend)}`,
    '',
    'Run it on your own machine with `npm run check:dropout-copy` in bng-metric-harness.',
    ''
  ]
}

/**
 * The job summary for one run.
 *
 * @param {object} result
 * @param {string[]} [result.missing] upload codes with no entry
 * @param {string[]} [result.stale] entries for codes the backend lacks
 * @param {boolean} [result.noCopyFile] the frontend has no copy file at all
 * @param {number} result.uploadCount upload codes checked
 * @param {{missing: string[], stale: string[]} | null} [result.edit] the
 *   edit section compared with the backend's edit codes; null when either
 *   predates the split
 * @param {number} result.editCount edit rules, which need no entry
 * @param {number} [result.editChecked] edit codes checked against the edit
 *   section
 * @param {object} context
 * @param {string} context.copyFile the copy file's path in the frontend
 * @param {Record<string, {plain?: string, unclassified?: boolean, description?: string, raisedAt?: object[]}>} [context.rules]
 *   for each missing code: the explainer's plain-English description, whether
 *   the explainer has yet to classify it, and the backend's description and
 *   raise sites
 * @param {{commit?: string, branch?: string}} [context.backend]
 * @param {{commit?: string, branch?: string}} [context.frontend]
 * @returns {string}
 */
export function renderSummary(result, context) {
  const copyFileLink = fileLink(
    FRONTEND_REPO_URL,
    context.frontend?.commit,
    context.copyFile
  )
  const ctx = { ...context, copyFileLink }
  const rules = context.rules ?? {}

  if (result.noCopyFile) {
    return [
      '## ❌ Drop-out page wording: the wording file is missing',
      '',
      `The frontend has no ${copyFileLink}, so this check cannot compare anything. Every refused upload would be explained with the generic message.`,
      '',
      '**What to do:** check whether the file was moved or renamed in bng-metric-frontend. If it was, update `ERROR_TEXT_FILE` in the harness\'s `validation-facts.mjs` to match.',
      '',
      ...footer(ctx)
    ].join('\n')
  }

  const missing = result.missing ?? []
  const stale = result.stale ?? []
  const edit = result.edit ?? null
  const editProblems = (edit?.missing.length ?? 0) + (edit?.stale.length ?? 0)
  if (missing.length === 0 && stale.length === 0 && editProblems === 0) {
    return [
      '## ✅ Drop-out page wording: nothing to fix',
      '',
      `Every error that can refuse an upload has an entry in the drop-out page wording${edit ? ', every error that can refuse an edit has one in the edit section,' : ''} and there are no entries for errors the service no longer has.`,
      '',
      '| | |',
      '| --- | --- |',
      `| Upload errors checked | ${result.uploadCount} |`,
      edit
        ? `| Errors for changes made on screen, checked against the edit section | ${result.editChecked} |`
        : `| Errors for changes made on screen, which the frontend words itself and need no entry | ${result.editCount} |`,
      '',
      `The wording is in ${copyFileLink}. An entry can still be a stop-gap that shows the generic message; this check does not judge the wording itself.`,
      '',
      ...footer(ctx)
    ].join('\n')
  }

  const found = [
    missing.length > 0 &&
      `- **${missing.length} upload error${missing.length === 1 ? '' : 's'} with no wording** — users who meet ${missing.length === 1 ? 'it' : 'one'} are not told what is wrong with their file.`,
    stale.length > 0 &&
      `- **${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} for errors the service no longer has** — no user is affected; the wording is unused.`,
    edit?.missing.length > 0 &&
      `- **${edit.missing.length} on-screen error${edit.missing.length === 1 ? '' : 's'} with no entry in the edit section** — the page cannot show ${edit.missing.length === 1 ? 'its' : 'their'} own message.`,
    edit?.stale.length > 0 &&
      `- **${edit.stale.length} edit-section entr${edit.stale.length === 1 ? 'y' : 'ies'} for errors that refuse no edit** — no user is affected.`
  ].filter(Boolean)

  return [
    '## ⚠️ Drop-out page wording needs attention',
    '',
    `This check compares the errors the service can refuse an upload${edit ? ' or an edit' : ''} with against the wording in ${copyFileLink}. It found:`,
    '',
    ...found,
    '',
    ...(missing.length > 0 ? missingSection(missing, rules, ctx) : []),
    ...(stale.length > 0 ? staleSection(stale, ctx) : []),
    ...(editProblems > 0 ? editSection(edit, ctx) : []),
    ...footer(ctx)
  ].join('\n')
}
