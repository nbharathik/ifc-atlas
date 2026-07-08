/**
 * BCF (BIM Collaboration Format) topics API client + pure helpers for the
 * BCF panel.
 *
 * Backend contract (topics are stored per model fingerprint; every route
 * answers 400 "No IFC model loaded" when nothing is loaded):
 *   GET    /api/bcf/topics                    -> { topics: [Topic] }
 *   POST   /api/bcf/topics                    -> Topic
 *   PATCH  /api/bcf/topics/{guid}             -> Topic (404 unknown guid)
 *   DELETE /api/bcf/topics/{guid}             -> { deleted: true }
 *   POST   /api/bcf/topics/{guid}/comments    -> Topic (comment appended)
 *   GET    /api/bcf/topics/{guid}/snapshot    -> image/jpeg (404 when none)
 *   GET    /api/bcf/export                    -> .bcfzip attachment (BCF 2.1)
 *   POST   /api/bcf/import (multipart "file") -> { imported, skipped, topics }
 */
import { apiUrl } from '../../lib/platform';
import type {
  ApplyViewStateRequest,
  CapturedViewState,
} from '../viewer/viewerBridge';

// Wire types (snake_case mirrors the backend JSON exactly)

export type BcfTopicType = 'Issue' | 'Comment' | 'Request' | 'Clash';
export type BcfStatus = 'Open' | 'In Progress' | 'Resolved' | 'Closed';
export type BcfPriority = 'Low' | 'Normal' | 'High' | 'Critical';

export const BCF_STATUSES: readonly BcfStatus[] = [
  'Open',
  'In Progress',
  'Resolved',
  'Closed',
];

export const BCF_PRIORITIES: readonly BcfPriority[] = [
  'Low',
  'Normal',
  'High',
  'Critical',
];

export interface BcfComment {
  guid: string;
  author: string;
  /** ISO timestamp. */
  date: string;
  comment: string;
}

export interface BcfViewpoint {
  camera: {
    pos: [number, number, number];
    target: [number, number, number];
  };
  isolated_ids: number[];
  hidden_ids: number[];
  selected_id: number | null;
  highlighted_ids: number[];
}

export interface BcfTopic {
  guid: string;
  title: string;
  description: string;
  topic_type: BcfTopicType;
  status: BcfStatus;
  priority: BcfPriority;
  assigned_to: string;
  author: string;
  /** ISO timestamps. */
  created_at: string;
  modified_at: string;
  labels: string[];
  comments: BcfComment[];
  viewpoint: BcfViewpoint | null;
  has_snapshot: boolean;
}

export interface BcfTopicCreate {
  title: string;
  description?: string;
  status?: BcfStatus;
  priority?: BcfPriority;
  topic_type?: BcfTopicType;
  assigned_to?: string;
  labels?: string[];
  viewpoint?: BcfViewpoint;
  /** "data:image/jpeg;base64,..." - the server stores the decoded jpeg. */
  snapshot_data_url?: string;
}

export interface BcfTopicPatch {
  title?: string;
  description?: string;
  status?: BcfStatus;
  priority?: BcfPriority;
  assigned_to?: string;
  labels?: string[];
}

export interface BcfImportResult {
  imported: number;
  skipped: number;
  topics: BcfTopic[];
}

// Pure helpers (exported for the panel and for unit tests)

/**
 * Status -> CSS custom-property reference for the row colour bar.
 * Returns a var() string so the theme (dark/light) resolves the actual colour.
 */
export function statusColor(status: BcfStatus): string {
  switch (status) {
    case 'Open':
      return 'var(--acc)';
    case 'In Progress':
      return 'var(--amber)';
    case 'Resolved':
      return 'var(--green-live)';
    case 'Closed':
      return 'var(--f-3)';
  }
}

/** Map a viewer-bridge capture (camelCase) to the wire viewpoint (snake_case). */
export function captureToViewpoint(capture: CapturedViewState): BcfViewpoint {
  return {
    camera: {
      pos: capture.camera.pos,
      target: capture.camera.target,
    },
    isolated_ids: capture.isolatedIds,
    hidden_ids: capture.hiddenIds,
    selected_id: capture.selectedId,
    highlighted_ids: capture.highlightedIds,
  };
}

/** Map a wire viewpoint (snake_case) to a viewer-bridge apply request (camelCase). */
export function viewpointToApplyRequest(
  viewpoint: BcfViewpoint,
): ApplyViewStateRequest {
  return {
    camera: viewpoint.camera,
    isolatedIds: viewpoint.isolated_ids,
    hiddenIds: viewpoint.hidden_ids,
    selectedId: viewpoint.selected_id,
    highlightedIds: viewpoint.highlighted_ids,
  };
}

/**
 * Compact relative date for topic rows and comment timelines.
 * Future timestamps (clock skew between server and client) read "just now".
 * Anything older than a week falls back to an absolute date; invalid input
 * yields an empty string so the row simply omits the date.
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '';
  const diffMs = now.getTime() - timestamp;
  if (diffMs < 45_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// API client

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** List every topic stored for the loaded model. */
export async function fetchBcfTopics(): Promise<BcfTopic[]> {
  const data = await requestJson<{ topics: BcfTopic[] }>('/api/bcf/topics');
  return data.topics;
}

/** Create a topic, optionally with a captured viewpoint + snapshot. */
export async function createBcfTopic(input: BcfTopicCreate): Promise<BcfTopic> {
  return requestJson<BcfTopic>('/api/bcf/topics', jsonInit('POST', input));
}

/** Patch mutable topic fields; resolves to the updated topic. */
export async function updateBcfTopic(
  guid: string,
  patch: BcfTopicPatch,
): Promise<BcfTopic> {
  return requestJson<BcfTopic>(
    `/api/bcf/topics/${encodeURIComponent(guid)}`,
    jsonInit('PATCH', patch),
  );
}

/** Delete a topic (and its snapshot) permanently. */
export async function deleteBcfTopic(guid: string): Promise<void> {
  await requestJson<{ deleted: boolean }>(
    `/api/bcf/topics/${encodeURIComponent(guid)}`,
    { method: 'DELETE' },
  );
}

/** Append a comment; resolves to the topic with the new comment included. */
export async function addBcfComment(
  guid: string,
  comment: string,
  author?: string,
): Promise<BcfTopic> {
  const payload: { comment: string; author?: string } = { comment };
  if (author !== undefined) payload.author = author;
  return requestJson<BcfTopic>(
    `/api/bcf/topics/${encodeURIComponent(guid)}/comments`,
    jsonInit('POST', payload),
  );
}

/**
 * Import a .bcfzip; the server merges by guid (incoming wins) and returns
 * the full merged topic list.
 */
export async function importBcfZip(file: File): Promise<BcfImportResult> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<BcfImportResult>('/api/bcf/import', {
    method: 'POST',
    body: form,
  });
}

/** Download URL for the BCF 2.1 .bcfzip export (use as an anchor href). */
export function bcfExportUrl(): string {
  return apiUrl('/api/bcf/export');
}

/** Image URL for a topic's snapshot (only valid when topic.has_snapshot). */
export function bcfSnapshotUrl(guid: string): string {
  return apiUrl(`/api/bcf/topics/${encodeURIComponent(guid)}/snapshot`);
}
