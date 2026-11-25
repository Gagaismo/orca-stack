// Perks (#393): optional parts of the stack that a config switch turns on. Off by default: a missing `perks` key,
// a missing perk or a value that is not `true` counts as off, so orca-stack works completely without any of them.
export const PERKS = ['marchas', 'caveman']

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// The on/off state of every perk in a merged config.
export const perksOf = config => {
  const raw = isPlain(config?.perks) ? config.perks : {}

  return Object.fromEntries(PERKS.map(perk => [perk, raw[perk] === true]))
}

// The `perks` of several config layers merged as every config key is: objects key by key, anything else replaces.
export const mergedPerks = (...layers) =>
  layers.reduce((acc, layer) => {
    const value = isPlain(layer) ? layer.perks : undefined
    if (value === undefined) return acc

    return isPlain(acc) && isPlain(value) ? { ...acc, ...value } : value
  }, undefined)

// What `doctor` reports: a `perks` that is not an object, or a perk whose value is not a boolean.
export const perkProblems = config => {
  const raw = config?.perks
  if (raw === undefined) return []
  if (!isPlain(raw)) return [{ label: 'perks', detail: `no es un objeto (${JSON.stringify(raw)}): todos los perks cuentan como apagados` }]

  return PERKS.filter(perk => raw[perk] !== undefined && typeof raw[perk] !== 'boolean').map(perk => ({
    label: `perks.${perk}`,
    detail: `no es booleano (${JSON.stringify(raw[perk])}): el perk cuenta como apagado`,
  }))
}

// A perk's text in an asset sits between `<!-- perk:<name> -->` and `<!-- /perk:<name> -->`: kept without the markers
// when the perk is on, dropped when it is off. A marker alone on its line takes its line break with it.
export const applyPerks = (text, perks) =>
  text.replace(/<!-- perk:(\w+) -->\n?([\s\S]*?)<!-- \/perk:\1 -->\n?/g, (whole, perk, inner) => (perks[perk] === true ? inner : ''))

// ADR 0002 (#429): Ponytail was removed; doctor flags any config layer that still sets perks.ponytail.
export const hasRetiredPonytailPerk = config => isPlain(config?.perks) && Object.hasOwn(config.perks, 'ponytail')
