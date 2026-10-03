import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, PromptComposeInput, PromptComposeSection } from 'claude-code'

const SECTIONS: PromptComposeSection[] = [
  { id: 'intro', text: 'You are an agent.', scope: 'shared' },
  { id: 'tone', text: 'Be brief.', scope: 'shared' },
  { id: 'memory', text: 'Remember things.', scope: 'session' },
]

const COMPOSE: PromptComposeInput = {
  model: 'test',
  promptModel: 'test',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

const run = (args: string): CommandRunInput => ({
  command: 'system-promt',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 80 },
})

test('exports, edits through a file, and resets', async ($, on) => {
  const disk = new Map<string, string>()
  let mtimeMs = 1
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  mock.clock(on)
  on('prompt.compose', () => ({ sections: SECTIONS }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.write', ($, e) => {
    disk.set(e.path, e.text)
    mtimeMs += 1

    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: disk.get(e.path) ?? '' }))
  on('fs.stat', ($, e) => {
    const text = disk.get(e.path)

    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: { kind: 'file', size: text.length, mtimeMs, isLink: false } }
  })

  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a command.', mcp: false }] }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))

  // A request's render comes first in a session; the mod composes as it did.
  await $.prompt.compose(COMPOSE)

  await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Use tabs.' }] })
  await $.prompt.attachment({ type: 'skill_listing', text: 'Skills: a, b', origin: { kind: 'engine' } })

  const out = await $.command.run(run('export out.md'))
  expect(out.text).toBe(
    'Exported 3 sections, 1 context blocks, 1 injected messages and 1 tools to out.md',
  )
  const file = [...disk.keys()].find(one => one.endsWith('/out.md')) ?? ''
  expect(disk.get(file)).toContain('## tone (shared)\n\nBe brief.')
  expect(disk.get(file)).toContain('## claudeMd\n\nUse tabs.')
  expect(disk.get(file)).toContain('## skill_listing\n\nSkills: a, b')
  expect(disk.get(file)).toContain('## Bash\n\nRuns a command.')

  const editing = await $.command.run(run('edit tone'))
  const path = '/home/me/.claude/system-promt/tone.md'
  expect(editing.text).toContain(path)
  expect(disk.get(path)).toBe('Be brief.')

  disk.set(path, 'Be a pirate.')
  mtimeMs += 1
  const changed = await $.prompt.compose(COMPOSE)
  expect(changed.sections.map(one => one.text)).toEqual([
    'You are an agent.',
    'Be a pirate.',
    'Remember things.',
  ])
  expect((await $.command.run(run('list'))).text).toContain('✎ tone')

  disk.set(path, '  ')
  mtimeMs += 1
  expect((await $.prompt.compose(COMPOSE)).sections.map(one => one.id)).toEqual(['intro', 'memory'])

  await $.command.run(run('reset tone'))
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)

  const opened = await $.command.run(run('allow everything'))
  expect(opened.text).toContain('Removed 1 instruction sections from the system prompt: tone.')
  expect((await $.prompt.compose(COMPOSE)).sections.map(one => one.id)).toEqual(['intro', 'memory'])
  // A second run leaves the backup of the original text alone.
  await $.command.run(run('allow everything'))
  await $.command.run(run('reset all'))
  expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)
  expect(disk.get(path)).toBe('Be brief.')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows the picked section on ${surface}`, async ($, on) => {
    mock.store(on)
    mock.env(on, { HOME: '/home/me' })
    on('prompt.compose', () => ({ sections: SECTIONS }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.prompt.compose(COMPOSE)

    const opened = await $.command.run(run(''))
    expect(opened.text).toBe('System prompt pane opened.')

    const target = {
      plugin: 'system-promt',
      surface,
      component: 'Pane',
      requestId: 'system-promt',
      props: {
        title: 'System prompt',
        isFocused: true,
        bodyColumns: 80,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    } as const
    const ui = await $.ui.mount(target)
    expect(await ui.find({ text: 'You are an agent.' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)

    await $.ui.select({ plugin: 'system-promt', key: 'section', value: 'memory' })
    expect(await ui.find({ text: 'Remember things.' })).toBeDefined()
  })
}
