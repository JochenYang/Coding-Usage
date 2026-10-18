import { describe, expect, it } from 'vitest'
import { EFFORT_LEVELS, orderEfforts, sameMembers, sameSequence } from './agent-config'

describe('orderEfforts', () => {
  it('sorts a shuffled ladder weakest first', () => {
    expect(orderEfforts(['high', 'none', 'max', 'low'])).toEqual(['none', 'low', 'high', 'max'])
  })

  it('keeps the full ladder in the declared order', () => {
    expect(orderEfforts([...EFFORT_LEVELS].reverse())).toEqual([...EFFORT_LEVELS])
  })

  it('leaves an already ordered ladder alone', () => {
    const ladder = ['none', 'low', 'medium', 'high']
    expect(orderEfforts(ladder)).toEqual(ladder)
  })

  it('does not mutate its input', () => {
    const ladder = ['max', 'low']
    orderEfforts(ladder)
    expect(ladder).toEqual(['max', 'low'])
  })

  it('places unknown levels after the known ones, keeping their order', () => {
    // The accepted set is whatever a model declares, not a fixed enum.
    expect(orderEfforts(['zebra', 'high', 'alpha', 'minimal'])).toEqual([
      'minimal',
      'high',
      'zebra',
      'alpha',
    ])
  })

  it('places the non-rung states before every rung', () => {
    // `off` disables thinking and `on` is ungraded thinking — neither is a
    // strength, so neither may sort above `max` (that would put the disable
    // switch at the strongest end of the picker).
    expect(orderEfforts(['high', 'off', 'max', 'on'])).toEqual(['off', 'on', 'high', 'max'])
  })

  it('sorts a descending ladder ascending', () => {
    expect(orderEfforts(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'])).toEqual([
      ...EFFORT_LEVELS,
    ])
  })

  it('keeps a lone off level', () => {
    expect(orderEfforts(['off'])).toEqual(['off'])
  })

  it('handles the empty ladder', () => {
    expect(orderEfforts([])).toEqual([])
  })
})

describe('sameSequence', () => {
  it('is true only for equal order', () => {
    expect(sameSequence(['none', 'low'], ['none', 'low'])).toBe(true)
    expect(sameSequence(['low', 'none'], ['none', 'low'])).toBe(false)
  })

  it('is false for different lengths', () => {
    expect(sameSequence(['none'], ['none', 'low'])).toBe(false)
  })

  it('differs from sameMembers, which ignores order', () => {
    const order = ['low', 'none']
    const canonical = ['none', 'low']
    expect(sameMembers(order, canonical)).toBe(true)
    expect(sameSequence(order, canonical)).toBe(false)
  })
})
