import type { Register } from 'claude-code'

import { allOk, describeRange, expandAnswer, findQuestions } from './questions'

const pending = { plugin: 'grilling-ok', key: 'pending' } as const

export const register: Register = on => {
  // The questions of the assistant's last message are the ones awaiting an answer.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      await $.state.set(pending, findQuestions(e.answer))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const { value: questions = [] } = await $.state.get(pending)
    if (questions.length === 0) {
      return next(e)
    }
    await $.state.set(pending, [])
    const text = expandAnswer(e.text, questions)
    if (text === undefined) {
      return next(e)
    }
    $.ui.toast(`Respondí ${describeRange(questions)}`)

    return next({ ...e, text })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: questions = [] } = await $.state.get(pending)
    if (e.props.hasSurvey || questions.length === 0) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>Preguntas {describeRange(questions)} · </Text>
        <Button
          key="all-ok"
          label="Todo ok"
          variant="primary"
          onPress={async () => {
            await $.state.set(pending, [])
            await $.prompt.submit({ text: allOk(questions), asUser: true })
          }}
        />
      </Box>
    )
  })
}
