import { CheckResult, LanguageVersion, NoticeDraft, VersionSnapshot } from './notice.model';

/**
 * 交接码离线传递格式（纯文本，可直接粘贴到聊天工具）：
 *
 *   ENH1-<base64url(payload)>-<8 位十六进制校验码>
 *
 * - payload 为 UTF-8 JSON，使用 Base64URL 承载中文并按 76 字符折行；
 * - 校验码为「折行前的 payload 文本」的 FNV-1a-32 摘要，
 *   任何删字、截断、改字都会在校验阶段被发现；
 * - 解析全程不碰 localStorage，失败时抛出 HandoffError（带可读中文原因）。
 */
export const HANDOFF_PREFIX = 'ENH1-';
export const WRAP_COLUMN = 76;

export interface HandoffEnvelope {
  format: 'emergency-notice-handoff';
  v: 1;
  exportedAt: string;
  from: string;
  draft: NoticeDraft;
}

export interface HandoffTodoItem {
  kind: 'blocking' | 'discussion' | 'review' | 'language' | 'info';
  title: string;
  detail: string;
}

export interface HandoffTodo {
  items: HandoffTodoItem[];
  blockingCount: number;
  discussionCount: number;
  pendingReviewCount: number;
}

export class HandoffError extends Error {}

/* ------------------------------------------------------------------ */
/* 编码                                                                 */
/* ------------------------------------------------------------------ */

/** FNV-1a 32 位摘要，输出 8 位十六进制。纯字符串运算，跨环境结果一致。 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function encodeHandoff(draft: NoticeDraft, from: string, exportedAt: string): string {
  const envelope: HandoffEnvelope = {
    format: 'emergency-notice-handoff',
    v: 1,
    exportedAt,
    from: from.trim() || '值班员',
    draft
  };
  const payload = bytesToBase64Url(utf8Encode(JSON.stringify(envelope)));
  const checksum = fnv1aHex(payload);
  return `${HANDOFF_PREFIX}${wrapText(payload, WRAP_COLUMN)}-${checksum}`;
}

/* ------------------------------------------------------------------ */
/* 解码与校验                                                           */
/* ------------------------------------------------------------------ */

export interface ParsedHandoff {
  envelope: HandoffEnvelope;
  draft: NoticeDraft;
}

/** 解析并校验交接码；任何失败都抛 HandoffError，不写入任何数据。 */
export function parseHandoff(code: string): ParsedHandoff {
  const text = code.trim();
  if (!text) throw new HandoffError('交接码为空，请粘贴完整的交接码后再试。');
  if (!text.startsWith(HANDOFF_PREFIX)) {
    throw new HandoffError('识别不到交接码标记：交接码应以“ENH1-”开头，请确认没有漏掉开头或误粘了其它内容。');
  }
  const body = text.slice(HANDOFF_PREFIX.length).replace(/\s+/g, '');
  const separator = body.lastIndexOf('-');
  if (separator <= 0) {
    throw new HandoffError('交接码缺少末尾校验段（形如 ENH1-……-a1b2c3d4），可能复制时被截断。');
  }
  const payload = body.slice(0, separator);
  const checksum = body.slice(separator + 1);
  if (!/^[0-9a-f]{8}$/i.test(checksum)) {
    throw new HandoffError(`校验段格式不正确（读到“${checksum.slice(0, 12) || '空'}”），应为 8 位十六进制字符。`);
  }
  if (fnv1aHex(payload).toLowerCase() !== checksum.toLowerCase()) {
    throw new HandoffError('校验码不一致：交接码内容可能在复制或转发时被改动、截断，请让交班员重新生成并完整粘贴。');
  }

  let envelope: HandoffEnvelope;
  try {
    envelope = JSON.parse(utf8Decode(base64UrlToBytes(payload))) as HandoffEnvelope;
  } catch {
    throw new HandoffError('载荷无法解码：内容已损坏或不是合法的交接码文本，请重新获取。');
  }
  validateEnvelope(envelope);
  return { envelope, draft: normalizeIncomingDraft(envelope.draft) };
}

/* ------------------------------------------------------------------ */
/* 待办摘要                                                             */
/* ------------------------------------------------------------------ */

/** 基于接班员最关心的未决事项生成摘要；checks 由组件按现有发布检查规则算好后传入。 */
export function buildHandoffTodo(draft: NoticeDraft, checks: CheckResult[]): HandoffTodo {
  const items: HandoffTodoItem[] = [];

  const errors = checks.filter((check) => check.level === 'error');
  errors.forEach((check) => items.push({
    kind: 'blocking',
    title: check.title,
    detail: check.detail
  }));

  const unresolved = draft.discussions.filter((discussion) => discussion.resolved === false);
  unresolved.forEach((discussion) => {
    const language = draft.languages.find((item) => item.id === discussion.languageId);
    items.push({
      kind: 'discussion',
      title: `未解决讨论：${language?.name ?? discussion.languageId}第 ${discussion.sentenceIndex + 1} 句`,
      detail: `${discussion.author}（${discussion.role}）：${discussion.text}`
    });
  });

  draft.reviews
    .filter((review) => review.status !== 'approved')
    .forEach((review) => items.push({
      kind: 'review',
      title: `${review.role}角色尚未确认（${review.owner}）`,
      detail: review.status === 'changes'
        ? `已退回修改${review.note ? `：${review.note}` : '。'}`
        : review.note || '状态为待审阅。'
    }));

  draft.requiredLocales.forEach((locale) => {
    const language = draft.languages.find((item) => item.id === locale);
    if (!language) {
      items.push({
        kind: 'language',
        title: `必需语言 ${locale} 版本缺失`,
        detail: '该语言尚未起草，发布前必须补齐翻译。'
      });
    } else if (!language.reviewed) {
      items.push({
        kind: 'language',
        title: `${language.name}版本未完成翻译复核`,
        detail: language.translator ? `译者：${language.translator}。` : '尚未指派译者。'
      });
    }
  });

  if (draft.emergencyRevision) {
    items.push({
      kind: 'info',
      title: '紧急修订进行中',
      detail: '该稿由已锁定版本派生，锁定原稿仍保留在版本链中；修订完成后需重新检查并锁定。'
    });
  }

  return {
    items,
    blockingCount: errors.length,
    discussionCount: unresolved.length,
    pendingReviewCount: draft.reviews.filter((review) => review.status !== 'approved').length
  };
}

/* ------------------------------------------------------------------ */
/* 锁定版本保护的版本链合并                                              */
/* ------------------------------------------------------------------ */

/** 仅锁定快照受保护：显式 locked 标记为准，老数据缺字段时按锁定标签兜底。 */
export function isLockedSnapshot(version: VersionSnapshot): boolean {
  return version.locked === true || (version.locked === undefined && version.label === '最终锁定版本');
}

export interface MergeResult {
  versions: VersionSnapshot[];
  /** 因被锁定而保留下来的本机快照 */
  protectedLocal: VersionSnapshot[];
}

/**
 * 合并本机与来件版本链：
 * - 非锁定快照：同一 id 用来件内容覆盖（随草稿交接）；
 * - 锁定快照：同一 id 一律保留本机版本，来件无法覆盖；
 * - 仅本机存在的快照原样保留（含锁定稿），仅来件存在的按来件顺序并入末尾。
 */
export function mergeVersionChains(local: VersionSnapshot[], incoming: VersionSnapshot[]): MergeResult {
  const merged = new Map<string, VersionSnapshot>();
  const protectedLocal: VersionSnapshot[] = [];

  incoming.forEach((version) => merged.set(version.id, version));
  local.forEach((version) => {
    const existing = merged.get(version.id);
    if (existing && isLockedSnapshot(version)) {
      merged.set(version.id, version);
      protectedLocal.push(version);
    } else if (!existing) {
      merged.set(version.id, version);
      if (isLockedSnapshot(version)) protectedLocal.push(version);
    }
  });

  // 以来件链顺序为基准，本机多出的快照（含未交接的锁定稿）按时间追加在末尾
  const orderedIncoming = incoming.map((version) => merged.get(version.id)!).filter(Boolean);
  const extras = local
    .filter((version) => !incoming.some((item) => item.id === version.id))
    .map((version) => merged.get(version.id)!)
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return { versions: [...orderedIncoming, ...extras], protectedLocal };
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

/** 校验交接码结构；只检查形态，不做业务修复，失败即给出可读原因。 */
function validateEnvelope(envelope: HandoffEnvelope): void {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new HandoffError('交接内容不是有效的 JSON 对象，请确认粘贴的是完整交接码。');
  }
  if (envelope.format !== 'emergency-notice-handoff') {
    throw new HandoffError('内容标识不是本工具的交接格式（期望 emergency-notice-handoff）。');
  }
  if (envelope.v !== 1) {
    throw new HandoffError(`交接码版本不受支持（读到 v${String(envelope.v)}），请使用同版本工具生成的交接码。`);
  }
  if (!isIsoDate(envelope.exportedAt)) {
    throw new HandoffError('交接时间字段缺失或无法识别，交接码可能已损坏。');
  }
  if (typeof envelope.from !== 'string' || !envelope.from.trim()) {
    throw new HandoffError('交班人信息缺失，请让交班员重新生成交接码。');
  }
  validateDraft(envelope.draft);
}

function validateDraft(draft: NoticeDraft): void {
  const path = '草稿';
  if (typeof draft !== 'object' || draft === null) {
    throw new HandoffError(`${path}内容缺失或不是对象，交接码可能已损坏。`);
  }
  const requireString = (field: keyof NoticeDraft, label: string): void => {
    const value = draft[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new HandoffError(`${path}缺少“${label}”，交接码不完整，请重新生成。`);
    }
  };
  requireString('id', '草稿编号');
  requireString('title', '通知标题');
  requireString('version', '版本号');
  requireString('updatedAt', '更新时间');

  const stringFields: Array<[keyof NoticeDraft, string]> = [
    ['eventType', '事件类型'], ['severity', '严重程度'], ['scope', '影响范围'],
    ['eventAt', '事件时间'], ['effectiveAt', '生效时间'], ['expiresAt', '失效时间']
  ];
  stringFields.forEach(([field, label]) => {
    if (typeof draft[field] !== 'string') {
      throw new HandoffError(`${path}的“${label}”字段类型不正确，交接码可能已损坏。`);
    }
  });
  if (typeof draft.status !== 'string' || !['draft', 'in-review', 'locked'].includes(draft.status)) {
    throw new HandoffError(`${path}状态值无法识别（${String(draft.status)}）。`);
  }
  if (typeof draft.emergencyRevision !== 'boolean') {
    throw new HandoffError(`${path}缺少紧急修订标记。`);
  }

  const stringArrays: Array<[keyof NoticeDraft, string]> = [
    ['channels', '发布渠道'], ['requiredLocales', '必需语言']
  ];
  stringArrays.forEach(([field, label]) => {
    const value = draft[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new HandoffError(`${path}的“${label}”不是字符串数组，交接码可能已损坏。`);
    }
  });

  validateLanguages(draft, path);
  validateDiscussions(draft, path);
  validateReviews(draft, path);
  validateVersions(draft, path);
}

function validateLanguages(draft: NoticeDraft, path: string): void {
  if (!Array.isArray(draft.languages) || draft.languages.length === 0) {
    throw new HandoffError(`${path}不包含任何语言版本，交接码不完整。`);
  }
  const ids = new Set<string>();
  draft.languages.forEach((language: LanguageVersion, index: number) => {
    const label = `${path}第 ${index + 1} 个语言版本`;
    if (typeof language !== 'object' || language === null) {
      throw new HandoffError(`${label}不是有效对象。`);
    }
    (['id', 'locale', 'name', 'title', 'body', 'translator'] as const).forEach((field) => {
      if (typeof language[field] !== 'string') {
        throw new HandoffError(`${label}缺少“${field}”文本字段，交接码不完整。`);
      }
    });
    if (typeof language.reviewed !== 'boolean') {
      throw new HandoffError(`${label}的复核标记不是布尔值。`);
    }
    if (ids.has(language.id)) {
      throw new HandoffError(`${path}存在重复语言编号“${language.id}”，交接码可能已损坏。`);
    }
    ids.add(language.id);
  });
}

function validateDiscussions(draft: NoticeDraft, path: string): void {
  if (!Array.isArray(draft.discussions)) {
    throw new HandoffError(`${path}的逐句讨论列表缺失。`);
  }
  draft.discussions.forEach((discussion, index) => {
    const label = `${path}第 ${index + 1} 条讨论`;
    if (typeof discussion !== 'object' || discussion === null) {
      throw new HandoffError(`${label}不是有效对象。`);
    }
    (['id', 'languageId', 'author', 'role', 'text', 'createdAt'] as const).forEach((field) => {
      if (typeof discussion[field] !== 'string') {
        throw new HandoffError(`${label}缺少“${field}”字段。`);
      }
    });
    if (typeof discussion.sentenceIndex !== 'number' || discussion.sentenceIndex < 0) {
      throw new HandoffError(`${label}绑定的句子序号无效。`);
    }
    if (typeof discussion.resolved !== 'boolean') {
      throw new HandoffError(`${label}缺少“resolved”标记。`);
    }
  });
}

function validateReviews(draft: NoticeDraft, path: string): void {
  if (!Array.isArray(draft.reviews)) {
    throw new HandoffError(`${path}的角色确认列表缺失。`);
  }
  draft.reviews.forEach((review, index) => {
    const label = `${path}第 ${index + 1} 个角色确认`;
    if (typeof review !== 'object' || review === null) {
      throw new HandoffError(`${label}不是有效对象。`);
    }
    if (typeof review.role !== 'string' || typeof review.owner !== 'string' || typeof review.note !== 'string') {
      throw new HandoffError(`${label}缺少角色、负责人或备注文本。`);
    }
    if (!['pending', 'approved', 'changes'].includes(review.status)) {
      throw new HandoffError(`${label}状态值无效（${String(review.status)}）。`);
    }
  });
}

function validateVersions(draft: NoticeDraft, path: string): void {
  if (!Array.isArray(draft.versions) || draft.versions.length === 0) {
    throw new HandoffError(`${path}的版本链为空，无法交接历史版本。`);
  }
  const ids = new Set<string>();
  draft.versions.forEach((version, index) => {
    const label = `${path}版本链第 ${index + 1} 项`;
    if (typeof version !== 'object' || version === null) {
      throw new HandoffError(`${label}不是有效对象。`);
    }
    (['id', 'label', 'createdAt', 'version', 'title', 'severity', 'scope',
      'eventAt', 'effectiveAt', 'expiresAt', 'note'] as const).forEach((field) => {
      if (typeof version[field] !== 'string') {
        throw new HandoffError(`${label}缺少“${field}”字段。`);
      }
    });
    if (!Array.isArray(version.channels) || version.channels.some((item) => typeof item !== 'string')) {
      throw new HandoffError(`${label}的渠道列表无效。`);
    }
    if (!Array.isArray(version.languages) || version.languages.length === 0) {
      throw new HandoffError(`${label}不包含语言正文快照。`);
    }
    version.languages.forEach((snapshotLanguage, languageIndex) => {
      const languageLabel = `${label}第 ${languageIndex + 1} 个语言快照`;
      if (typeof snapshotLanguage !== 'object' || snapshotLanguage === null) {
        throw new HandoffError(`${languageLabel}不是有效对象。`);
      }
      (['id', 'locale', 'name', 'title', 'body', 'translator'] as const).forEach((field) => {
        if (typeof snapshotLanguage[field] !== 'string') {
          throw new HandoffError(`${languageLabel}缺少“${field}”文本字段。`);
        }
      });
      if (typeof snapshotLanguage.reviewed !== 'boolean') {
        throw new HandoffError(`${languageLabel}的复核标记不是布尔值。`);
      }
    });
    if (typeof version.emergency !== 'boolean') {
      throw new HandoffError(`${label}缺少紧急修订标记。`);
    }
    if (ids.has(version.id)) {
      throw new HandoffError(`${label}与版本链中其它快照编号重复（${version.id}）。`);
    }
    ids.add(version.id);
  });
}

/** 补齐老版本交接码里可能缺省的可选字段，并给历史锁定快照补 locked 标记。 */
export function normalizeIncomingDraft(draft: NoticeDraft): NoticeDraft {
  const normalized = draft;
  normalized.discussions ??= [];
  normalized.reviews ??= [];
  normalized.requiredLocales ??= [];
  normalized.channels ??= [];
  normalized.versions.forEach((version) => {
    if (version.locked === undefined) {
      version.locked = version.label === '最终锁定版本';
    }
  });
  return normalized;
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function wrapText(text: string, column: number): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += column) {
    lines.push(text.slice(i, i + column));
  }
  return lines.join('\n');
}

/* ---- UTF-8 + Base64URL（不依赖 atob，保证 Unicode 正确） ---- */

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
