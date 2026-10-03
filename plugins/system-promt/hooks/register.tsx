import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PromptComposeInput,
  PromptContextBlock,
  PromptComposeSection,
  Register,
  ToolInfo,
} from 'claude-code'

const NAME = 'system-promt'
const PANE = 'system-promt'
const OVERRIDES = 'overrides'
const SHOWN_CHARS = 20000
const USAGE =
  'Usage: /system-promt [list | export [path] | edit <section> | reset <section|all>]'

const selected = atom({ plugin: 'system-promt', key: 'selected' } as const, null)
const revision = atom({ plugin: 'system-promt', key: 'revision' } as const, 0)

type Overrides = Record<string, string>
type Row = PromptComposeSection & { isEdited: boolean }

const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

const overridesOf = async ($: EngineInterface): Promise<Overrides> => {
  const kept = await $.store.get(OVERRIDES)
  const map: Overrides = {}

  if (kept !== null && typeof kept === 'object') {
    for (const [id, path] of Object.entries(kept)) {
      if (typeof path === 'string') {
        map[id] = path
      }
    }
  }

  return map
}

const folder = async ($: EngineInterface): Promise<string> => {
  const home = await $.env.get('HOME')

  return home === undefined ? '.claude/system-promt' : `${home}/.claude/system-promt`
}

// The sections as the engine composed them, before this mod's edits; the
// compose hook below refreshes them on every render of the prompt.
let originals: readonly PromptComposeSection[] = []
// The facts the engine last rendered the prompt for, so the pane composes the same one.
let lastInput: PromptComposeInput | undefined
// What the model reads beside the system prompt, as it passed this mod since
// it loaded: the first message's context blocks and the engine's injected
// messages (reminders, listings), the main conversation's alone.
let contextBlocks: readonly PromptContextBlock[] = []
const injected = new Map<string, string[]>()
const files = new Map<string, { mtimeMs: number; size: number; text: string }>()

// An edited section's text is its file's, read again only when the file
// changed; undefined when the file is gone, which leaves the original.
const edited = async (
  $: EngineInterface,
  path: string,
): Promise<string | undefined> => {
  try {
    const stat = await $.fs.stat(path)
    const held = files.get(path)

    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) {
      return held.text
    }

    const text = await $.fs.read(path)
    files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text })

    return text
  } catch {
    return undefined
  }
}

const rows = async ($: EngineInterface): Promise<Row[]> => {
  originals = []
  const composed = await $.prompt.compose(lastInput)

  // When the call ran through this mod's own hook, `originals` is filled and
  // `composed` already carries the edits; otherwise `composed` is the engine's.
  const base = originals.length > 0 ? originals : composed.sections
  originals = base
  const overrides = await overridesOf($)
  const list: Row[] = []

  for (const one of base) {
    const path = overrides[one.id]
    const text = path === undefined ? undefined : await edited($, path)
    list.push({ ...one, text: text ?? one.text, isEdited: text !== undefined })
  }

  return list
}

const exported = (
  list: readonly Row[],
  tools: readonly ToolInfo[],
  when: number,
): string => {
  const chars = list.reduce((sum, one) => sum + one.text.length, 0)
  const notes = [...injected].flatMap(([type, texts]) =>
    texts.map(text => ['', `## ${type}`, '', text]).flat(),
  )
  const pending = '_None captured yet: send one message, then export again._'

  return [
    '# Everything the model is given',
    '',
    `Exported ${new Date(when).toISOString()}.`,
    '',
    `# 1. System prompt (${list.length} sections, ${chars} characters)`,
    ...list.flatMap(one => [
      '',
      `## ${one.id} (${one.scope}${one.isEdited ? ', edited' : ''})`,
      '',
      one.text,
    ]),
    '',
    `# 2. First-message context (${contextBlocks.length} blocks)`,
    ...(contextBlocks.length === 0 ? ['', pending] : []),
    ...contextBlocks.flatMap(one => ['', `## ${one.name}`, '', one.text]),
    '',
    `# 3. Injected messages (${notes.length / 4} captured)`,
    ...(notes.length === 0 ? ['', pending] : notes),
    '',
    `# 4. Tools (${tools.length})`,
    ...tools.flatMap(one => [
      '',
      `## ${one.name}${one.mcp ? ' (MCP)' : ''}`,
      '',
      one.description,
    ]),
    '',
  ].join('\n')
}

const exportTo = async ($: EngineInterface, path: string): Promise<string> => {
  const list = await rows($)
  const tools = await $.tool.list()
  await $.fs.write(path, exported(list, tools, await $.clock.now()))
  const notes = [...injected.values()].reduce((sum, one) => sum + one.length, 0)

  return `Exported ${list.length} sections, ${contextBlocks.length} context blocks, ${notes} injected messages and ${tools.length} tools to ${path}`
}

const edit = async ($: EngineInterface, id: string): Promise<string> => {
  const list = await rows($)
  const row = list.find(one => one.id === id)

  if (!row) {
    return `No section "${id}". Sections: ${list.map(one => one.id).join(', ')}`
  }

  const overrides = await overridesOf($)
  let path = overrides[id]

  if (path === undefined || !row.isEdited) {
    path = `${await folder($)}/${id.replace(/[^\w.-]/g, '_')}.md`
    await $.fs.write(path, row.text)
    await $.store.set(OVERRIDES, { ...overrides, [id]: path })
  }

  // Opens the file in the default text editor where the host has `open`.
  await $.process.run(['open', '-t', path]).catch(() => undefined)
  await update($, revision, n => n + 1)

  return `Editing "${id}": ${path}\nSave the file and the next request sends its text in place of the section; an empty file drops the section. /system-promt reset ${id} restores the original.`
}

const reset = async ($: EngineInterface, id: string): Promise<string> => {
  const overrides = await overridesOf($)
  const ids = id === 'all' ? Object.keys(overrides) : [id]
  const kept = Object.fromEntries(
    Object.entries(overrides).filter(([one]) => !ids.includes(one)),
  )
  const count = Object.keys(overrides).length - Object.keys(kept).length
  await $.store.set(OVERRIDES, kept)
  await update($, revision, n => n + 1)

  return count === 0
    ? `Nothing to reset for "${id}".`
    : `Restored ${count} section${count === 1 ? '' : 's'} to the original text; the edited files stay on disk, unused.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Show, export or edit the system prompt',
      argumentHint: '[list | export [path] | edit <section> | reset <section|all>]',
    })

    // Both answers are cached from before this mod loaded; asked again, they
    // pass the two hooks below on the next request.
    $.ui.invalidate('prompt.context')
    $.ui.invalidate('prompt.attachment')

    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const answer = await next(e)
    contextBlocks = answer.blocks

    return answer
  })

  on('prompt.attachment', async ($, e, next) => {
    const answer = await next(e)

    if (answer.text !== null && e.agentId === undefined) {
      const texts = injected.get(e.type) ?? []

      if (!texts.includes(answer.text)) {
        injected.set(e.type, [...texts, answer.text].slice(-20))
      }
    }

    return answer
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    lastInput = e
    originals = composed.sections
    const overrides = await overridesOf($)
    const sections: PromptComposeSection[] = []

    for (const one of composed.sections) {
      const path = overrides[one.id]
      const text = path === undefined ? undefined : await edited($, path)

      if (text === undefined) {
        sections.push(one)
      } else if (text.trim() !== '') {
        sections.push({ ...one, text })
      }
    }

    return { sections }
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const argument = rest.join(' ')

    if (verb === '') {
      await update($, revision, n => n + 1)
      await $.ui.open({ id: PANE, title: 'System prompt', focus: true })

      return { text: 'System prompt pane opened.' }
    }

    if (verb === 'list') {
      const list = await rows($)

      return {
        text: list
          .map(one => `${one.isEdited ? '✎' : ' '} ${one.id} (${one.scope}, ${compact(one.text.length)} chars)`)
          .join('\n'),
      }
    }

    if (verb === 'export') {
      return { text: await exportTo($, argument || 'system-prompt.md') }
    }

    if (verb === 'edit' && argument !== '') {
      return { text: await edit($, argument) }
    }

    if (verb === 'reset' && argument !== '') {
      return { text: await reset($, argument) }
    }

    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    await read($, revision)
    const list = await rows($)
    const picked = await read($, selected)
    const row = list.find(one => one.id === picked) ?? list[0]

    if (!row) {
      return <Text dimColor>No system prompt sections.</Text>
    }

    const chars = list.reduce((sum, one) => sum + one.text.length, 0)
    const editedCount = list.filter(one => one.isEdited).length

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {list.length} sections, {compact(chars)} chars, {editedCount} edited
        </Text>
        {'Select' in table ? (
          <table.Select
            key="section"
            label="Section"
            autoFocus
            value={row.id}
            options={list.map(one => ({
              value: one.id,
              label: `${one.isEdited ? '✎ ' : ''}${one.id} (${one.scope}, ${compact(one.text.length)})`,
            }))}
            onSelect={(id: string) => update($, selected, () => id)}
          />
        ) : (
          <Button
            key="next"
            label="Next section"
            onPress={() => {
              const after = list[(list.indexOf(row) + 1) % list.length]

              return update($, selected, () => after?.id ?? null)
            }}
          />
        )}
        <Box>
          <Button
            key="edit"
            label="Edit"
            hotkey="e"
            onPress={async () => {
              $.ui.toast((await edit($, row.id)).split('\n')[0] ?? '')
            }}
          />
          <Text> </Text>
          <Button
            key="reset"
            label="Reset"
            hotkey="r"
            onPress={async () => {
              $.ui.toast(await reset($, row.id))
            }}
          />
          <Text> </Text>
          <Button
            key="export"
            label="Export"
            hotkey="x"
            onPress={async () => {
              $.ui.toast(await exportTo($, 'system-prompt.md'))
            }}
          />
          <Text> </Text>
          <Button
            key="refresh"
            label="Refresh"
            hotkey="f"
            onPress={() => update($, revision, n => n + 1)}
          />
        </Box>
        <Text bold>
          {row.id}
          {row.isEdited ? ' (edited)' : ''}
        </Text>
        <Text wrap="wrap">{row.text.slice(0, SHOWN_CHARS)}</Text>
        {row.text.length > SHOWN_CHARS && (
          <Text dimColor>
            {compact(row.text.length - SHOWN_CHARS)} more chars; Export shows the whole text.
          </Text>
        )}
      </Box>
    )
  })
}
