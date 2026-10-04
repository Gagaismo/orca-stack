import path from 'node:path'

import { samePath } from './util.mjs'

const split = value => (typeof value === 'string' ? value.split(path.delimiter).filter(s => s.trim() !== '') : [])

// Adds the given dirs to CLAUDE_CODE_PLUGIN_DIRS keeping every entry already there, in order, with no duplicates.
// Returns { value, added } where added lists only the dirs this call really added.
export const mergePluginDirs = (current, dirs) => {
  const entries = split(current)
  const added = []
  for (const dir of dirs) {
    if (!entries.some(entry => samePath(entry, dir))) {
      entries.push(dir)
      added.push(dir)
    }
  }

  return { value: entries.join(path.delimiter), added }
}

export const removePluginDirs = (current, dirs) => {
  const entries = split(current)
  const kept = entries.filter(entry => !dirs.some(dir => samePath(entry, dir)))

  return { value: kept.join(path.delimiter), removed: entries.length - kept.length }
}

export const parseSettings = (text, file) => {
  if (text.trim() === '') {
    return {}
  }
  let data
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new Error(`No pude leer ${file} como JSON (${error.message}). No lo toqué: arreglalo y volvé a correr el comando.`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} no es un objeto JSON. No lo toqué.`)
  }

  return data
}

// Keeps the file's own indentation when it has one.
export const stringifySettings = (data, original) => {
  const indent = /^\{\r?\n([ \t]+)"/.exec(original ?? '')?.[1] ?? '  '
  const eol = original?.includes('\r\n') ? '\r\n' : '\n'

  return JSON.stringify(data, null, indent).replace(/\n/g, eol) + eol
}
