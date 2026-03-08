'use client'

import React, { useCallback, useState } from 'react'

import type { MappingEntry } from '../types.js'

import {
  buttonStyle,
  headingStyle,
  sectionStyle,
  statusBadgeStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from '../styles.js'

type EditableMappingEntry = {
  id?: string
  order: number
  source: string
  syncMode: string
  target: string
  transformPreset: string
}

const SYNC_MODE_OPTIONS = ['permanent', 'initialOnly'] as const
const TRANSFORM_OPTIONS = [
  'none',
  'toMicros',
  'toMicrosString',
  'extractUrl',
  'extractAbsoluteUrl',
  'toArray',
  'toString',
  'toBoolean',
] as const

const emptyMapping = (): EditableMappingEntry => ({
  order: 0,
  source: '',
  syncMode: 'permanent',
  target: '',
  transformPreset: 'none',
})

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-elevation-0)',
  border: '1px solid var(--theme-elevation-250)',
  borderRadius: '4px',
  fontSize: '13px',
  padding: '4px 8px',
  width: '100%',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: 'auto',
}

export const MerchantCenterFieldMappingsSection = (props: {
  apiBasePath: string
  mappings: MappingEntry[]
  onUpdate: (mappings: MappingEntry[]) => void
}): React.JSX.Element => {
  const { apiBasePath, mappings, onUpdate } = props
  const [editing, setEditing] = useState(false)
  const [editRows, setEditRows] = useState<EditableMappingEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const startEdit = useCallback(() => {
    setEditRows(mappings.length > 0 ? mappings.map((entry) => ({ ...entry })) : [emptyMapping()])
    setEditing(true)
    setError(null)
  }, [mappings])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setEditRows([])
    setError(null)
  }, [])

  const addRow = useCallback(() => {
    setEditRows((previous) => [...previous, emptyMapping()])
  }, [])

  const removeRow = useCallback((index: number) => {
    setEditRows((previous) => previous.filter((_, rowIndex) => rowIndex !== index))
  }, [])

  const updateRow = useCallback((
    index: number,
    field: keyof EditableMappingEntry,
    value: number | string,
  ) => {
    setEditRows((previous) => previous.map((row, rowIndex) => {
      return rowIndex === index ? { ...row, [field]: value } : row
    }))
  }, [])

  const saveAll = useCallback(async () => {
    const validRows = editRows.filter((row) => row.source.trim() && row.target.trim())

    if (validRows.length === 0 && editRows.length > 0) {
      setError('At least one mapping must have both source and target fields.')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const response = await fetch(`${apiBasePath}/mappings`, {
        body: JSON.stringify({
          mappings: validRows.map((row, index) => ({
            order: index,
            source: row.source.trim(),
            syncMode: row.syncMode,
            target: row.target.trim(),
            transformPreset: row.transformPreset,
          })),
        }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const mappingsResponse = await fetch(`${apiBasePath}/mappings`, { credentials: 'include' })
      if (mappingsResponse.ok) {
        const data = await mappingsResponse.json()
        onUpdate(data.mappings ?? [])
      }

      setEditing(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save mappings')
    } finally {
      setSaving(false)
    }
  }, [apiBasePath, editRows, onUpdate])

  return (
    <div style={sectionStyle}>
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ ...headingStyle, marginBottom: 0 }}>Field Mappings</h2>
        {!editing ? (
          <button onClick={startEdit} style={buttonStyle('secondary')} type="button">
            Edit Mappings
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button disabled={saving} onClick={addRow} style={buttonStyle('secondary')} type="button">
              + Add Row
            </button>
            <button disabled={saving} onClick={saveAll} style={buttonStyle('primary')} type="button">
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button disabled={saving} onClick={cancelEdit} style={buttonStyle('secondary')} type="button">
              Cancel
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{
          backgroundColor: '#fef2f2',
          borderRadius: '4px',
          color: '#991b1b',
          fontSize: '13px',
          marginBottom: '12px',
          padding: '8px 12px',
        }}>
          {error}
        </div>
      )}

      {editing ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Source Field</th>
              <th style={thStyle}>Target Field</th>
              <th style={thStyle}>Mode</th>
              <th style={thStyle}>Transform</th>
              <th aria-label="Actions" style={{ ...thStyle, width: '40px' }}></th>
            </tr>
          </thead>
          <tbody>
            {editRows.map((row, index) => (
              <tr key={`${row.id ?? 'new'}-${index.toString()}`}>
                <td style={tdStyle}>
                  <input
                    aria-label="Source field path"
                    onChange={(event) => updateRow(index, 'source', event.target.value)}
                    placeholder="e.g. title"
                    style={inputStyle}
                    type="text"
                    value={row.source}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    aria-label="Target field path"
                    onChange={(event) => updateRow(index, 'target', event.target.value)}
                    placeholder="e.g. productAttributes.title"
                    style={inputStyle}
                    type="text"
                    value={row.target}
                  />
                </td>
                <td style={tdStyle}>
                  <select
                    aria-label="Sync mode"
                    onChange={(event) => updateRow(index, 'syncMode', event.target.value)}
                    style={selectStyle}
                    value={row.syncMode}
                  >
                    {SYNC_MODE_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <select
                    aria-label="Transform preset"
                    onChange={(event) => updateRow(index, 'transformPreset', event.target.value)}
                    style={selectStyle}
                    value={row.transformPreset}
                  >
                    {TRANSFORM_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <button
                    onClick={() => removeRow(index)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#dc2626',
                      cursor: 'pointer',
                      fontSize: '16px',
                      padding: '2px 6px',
                    }}
                    title="Remove"
                    type="button"
                  >
                    x
                  </button>
                </td>
              </tr>
            ))}
            {editRows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, color: 'var(--theme-elevation-500)', textAlign: 'center' }}>
                  No mappings. Click &quot;+ Add Row&quot; to add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : mappings.length > 0 ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Source Field</th>
              <th style={thStyle}>Target Field</th>
              <th style={thStyle}>Mode</th>
              <th style={thStyle}>Transform</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td style={tdStyle}><code>{mapping.source}</code></td>
                <td style={tdStyle}><code>{mapping.target}</code></td>
                <td style={tdStyle}>
                  <span style={statusBadgeStyle(mapping.syncMode)}>{mapping.syncMode}</span>
                </td>
                <td style={tdStyle}>{mapping.transformPreset || 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: '13px' }}>
          No field mappings configured. Click &quot;Edit Mappings&quot; to add them.
        </p>
      )}
    </div>
  )
}
