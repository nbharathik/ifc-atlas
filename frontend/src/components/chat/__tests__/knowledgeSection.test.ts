import { describe, expect, it } from 'vitest';
import {
  summarizeFetchResult,
  domainLabel,
  searchModeLabel,
} from '../ChatManagerPanel';
import type { ReferenceDocsSemanticStatus } from '../../../services/api';

describe('summarizeFetchResult', () => {
  it('formats a successful fetch with version and plural domains', () => {
    const r = summarizeFetchResult({
      ok: true,
      indexed: 68,
      errors: 0,
      domains: ['wall', 'pset'],
      ifcopenshell_version: '0.8.1',
      source: 'ifcopenshell.api',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Indexed 68 API domains from IfcOpenShell v0.8.1');
  });

  it('uses singular for one domain and appends partial-failure count', () => {
    const r = summarizeFetchResult({ ok: true, indexed: 1, errors: 1 });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Indexed 1 API domain (1 domain failed)');
  });

  it('pluralizes the failure count', () => {
    const r = summarizeFetchResult({ ok: true, indexed: 5, errors: 2 });
    expect(r.message).toBe('Indexed 5 API domains (2 domains failed)');
  });

  it('surfaces the backend error message on failure', () => {
    const r = summarizeFetchResult({
      ok: false,
      error: 'ifcopenshell not importable: boom',
      indexed: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('ifcopenshell not importable: boom');
  });

  it('falls back to a generic message when the failure has no error text', () => {
    expect(summarizeFetchResult({ ok: false }).message).toBe('Fetch failed');
    // Anything that is not exactly ok === true is a failure.
    expect(summarizeFetchResult({}).ok).toBe(false);
  });

  it('tolerates missing/odd fields on success', () => {
    const r = summarizeFetchResult({ ok: true });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Indexed 0 API domains');
  });
});

describe('domainLabel', () => {
  it('strips the ifcopenshell.api. prefix', () => {
    expect(domainLabel('ifcopenshell.api.wall')).toBe('wall');
    expect(domainLabel('ifcopenshell.api.spatial')).toBe('spatial');
  });

  it('returns undotted names as-is', () => {
    expect(domainLabel('geometry')).toBe('geometry');
  });

  it('handles null/undefined/empty from the backend list', () => {
    expect(domainLabel(null)).toBe('?');
    expect(domainLabel(undefined)).toBe('?');
    expect(domainLabel('')).toBe('?');
  });
});

describe('searchModeLabel', () => {
  const base: ReferenceDocsSemanticStatus = {
    available: false,
    built: false,
    model: 'BAAI/bge-small-en-v1.5',
    chunk_count: 0,
    alpha: 0.5,
  };

  it('reports hybrid when the semantic index is built', () => {
    expect(searchModeLabel({ ...base, available: true, built: true }))
      .toBe('Hybrid (semantic + keyword)');
  });

  it('reports available-but-unbuilt', () => {
    expect(searchModeLabel({ ...base, available: true }))
      .toBe('Keyword (BM25) - semantic index not built yet');
  });

  it('reports BM25-only when fastembed is unavailable', () => {
    expect(searchModeLabel(base)).toBe('Keyword (BM25) only');
  });
});
