// main.ts is mend, the CLI SPEC.md specifies: one tool that reads all four AI edit formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to one contract, finds the
// lines an edit names at the first of three matching tiers, and changes every file or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// The command line, output and exit codes, safe paths, format detection, JSON edits and the
// all-or-nothing write follow the kit starter's shape; the three line-matching formats (sections
// 6 to 8) and the three-tier matcher (section 5) are implemented here, as is the `R old -> new`
// output line for a move that succeeded.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, its lines, and whether it ends with a break (SPEC section 3). */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* Matching lines (SPEC section 5). */

const trailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWS(a) === trailWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions i where O's lines match the file's lines i, i+1, ... at the tier, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * One line of N: `text`, and `ctx`, the index into O of the context line it is, or null for a
 * line the patch adds. Context lines are written as the file's own matched line; other lines are
 * re-indented at tier 2 (section 5): let F be the leading spaces and tabs of the file's first
 * matched line and P those of O's first line; a non-blank line starting with P has P replaced by F.
 */
interface NLine {
  text: string;
  ctx: number | null;
}

function reindentLine(text: string, o: string[], fileLines: string[], pos: number, tier: number): string {
  if (tier !== 2 || o.length === 0) return text;
  if (text === '' || trimWS(text) === '') return text;
  const p = leadWS(o[0]!);
  if (!text.startsWith(p)) return text;
  return leadWS(fileLines[pos]!) + text.slice(p.length);
}

/* Format detection (SPEC section 4) and JSON edits (SPEC section 9), as the kit starter has them. */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Unified diffs (SPEC section 6). */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  plusNoEol: boolean;
  plusCount: number;
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed; a leading a/ or b/ removed; /dev/null means no file. */
function unifiedPath(raw: string): string | null {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: Array<{ k: string; t: string }> = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ k: l === '' ? ' ' : l[0]!, t: l === '' ? '' : l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.k === ' ' && last.t === '') body.pop();
    else break;
  }
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.k === ' ') {
      o.push(b.t);
      n.push({ text: b.t, ctx: o.length - 1 });
    } else if (b.k === '-') {
      o.push(b.t);
    } else if (b.k === '+') {
      n.push({ text: b.t, ctx: null });
    }
  }
  let noEol = false;
  let plusNoEol = false;
  let plusCount = 0;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.k === '+') plusCount += 1;
    if (!noEol && (b.k === ' ' || b.k === '+')) {
      if (k + 1 < body.length && body[k + 1]!.k === '\\') noEol = true;
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.k === '+') {
      if (k + 1 < body.length && body[k + 1]!.k === '\\') plusNoEol = true;
      break;
    }
  }
  return { hunk: { a, o, n, noEol, plusNoEol, plusCount }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let pairSeen = false;
  let state: 'prose' | 'header' | 'after' = 'prose';
  const startSection = (diffOld?: string, diffNew?: string): USection => {
    const s: USection = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld,
      diffNew,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    pairSeen = false;
    state = 'header';
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null && !pairSeen) {
        cur.pairOld = unifiedPath(line);
        cur.pairNew = unifiedPath(lines[i + 1]!);
        pairSeen = true;
      } else {
        const s = startSection();
        s.pairOld = unifiedPath(line);
        s.pairNew = unifiedPath(lines[i + 1]!);
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = unifiedPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === undefined) cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renameTo === undefined) cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        state = 'after';
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'after' && cur !== null && line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (state === 'prose' && line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld !== undefined ? sec.diffOld : null;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew !== undefined ? sec.diffNew : null;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.delFile);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree: Tree) => {
    const paths: string[] = [];
    if (oldP !== null) paths.push(oldP);
    if (newP !== null && newP !== oldP) paths.push(newP);
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const target = newP;
      if (target === null) throw new Fail('unsafe', '');
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let noEol = false;
      for (let h = sec.hunks.length - 1; h >= 0; h -= 1) {
        if (sec.hunks[h]!.plusCount > 0) {
          noEol = sec.hunks[h]!.plusNoEol;
          break;
        }
      }
      for (const h of sec.hunks) {
        for (const e of h.n) {
          if (e.ctx === null) plus.push(e.text);
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP as string;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP as string;
    if (tree.get(src) === null) throw new Fail('missing', src);
    if (isMove && tree.get(newP as string) !== null) throw new Fail('exists', newP as string);
    const f = splitFile(tree.get(src)!);
    const lines = f.lines.slice();
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const at = Math.min(h.a + d, lines.length);
        const ins = h.n.map((e) => e.text);
        // Section 6: when the insertion is at the end, the result ends with a line break
        // unless a `\` line follows the hunk's last context or `+` line.
        if (at === lines.length) f.final = !h.noEol;
        lines.splice(at, 0, ...ins);
        d += h.n.length;
      } else {
        const found = findTier(lines, h.o, strict, 0);
        if (found === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bd = Math.abs(best - target);
        for (const o of found.occ) {
          const dd = Math.abs(o - target);
          if (dd < bd) {
            best = o;
            bd = dd;
          }
        }
        const pos = best;
        if (pos + h.o.length === lines.length) f.final = !h.noEol;
        const rep = h.n.map((e) => (e.ctx !== null ? lines[pos + e.ctx]! : reindentLine(e.text, h.o, lines, pos, found.tier)));
        lines.splice(pos, h.o.length, ...rep);
        d += h.n.length - h.o.length;
      }
    }
    const text = joinFile({ br: f.br, lines, final: f.final });
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(newP as string, text);
      tree.moves.push([src, newP as string]);
    } else {
      tree.now.set(src, text);
    }
  };
}

/* SEARCH/REPLACE blocks (SPEC section 7). */

function searchReplaceEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, old, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = nw.map((t) => reindentLine(t, old, f.lines, pos, found.tier));
    const lines = f.lines.slice();
    lines.splice(pos, old.length, ...rep);
    tree.now.set(path, joinFile({ br: f.br, lines, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* V4A patches (SPEC section 8). */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind: 'add' | 'delete' | 'update' = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = line.slice(kind === 'add' ? 14 : 17).trim();
      const lineNo = i + 1;
      const raw: Array<{ t: string; no: number }> = [];
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push({ t: l, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      if (kind === 'add') {
        const flines: string[] = [];
        for (const r of raw) {
          if (r.t.startsWith('+')) flines.push(r.t.slice(1));
          else if (r.t === '') flines.push('');
          else throw new Exit2(`error: parse ${r.no}`);
        }
        sections.push({ kind, path, moveTo: null, lines: flines, chunks: [], lineNo });
      } else if (kind === 'delete') {
        for (const r of raw) {
          if (!blank(r.t)) throw new Exit2(`error: parse ${r.no}`);
        }
        sections.push({ kind, path, moveTo: null, lines: [], chunks: [], lineNo });
      } else {
        let moveTo: string | null = null;
        let rest = raw;
        if (rest.length > 0 && rest[0]!.t.startsWith('*** Move to: ')) {
          moveTo = rest[0]!.t.slice(13).trim();
          rest = rest.slice(1);
        }
        if (rest.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
        const chunks: VChunk[] = [];
        let cur: { anchor: string | null; eof: boolean; body: Array<{ k: string; t: string }> } | null = null;
        let started = false;
        const flush = (): void => {
          if (cur === null) return;
          const o: string[] = [];
          const n: NLine[] = [];
          for (const b of cur.body) {
            if (b.k === ' ') {
              o.push(b.t);
              n.push({ text: b.t, ctx: o.length - 1 });
            } else if (b.k === '-') {
              o.push(b.t);
            } else if (b.k === '+') {
              n.push({ text: b.t, ctx: null });
            }
          }
          chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
          cur = null;
        };
        for (const r of rest) {
          const l = r.t;
          if (l.startsWith('@@')) {
            flush();
            const anchor = l.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
            started = true;
            continue;
          }
          if (l === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${r.no}`);
            cur.eof = true;
            flush();
            continue;
          }
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
            cur.body.push({ k: l === '' ? ' ' : l[0]!, t: l === '' ? '' : l.slice(1) });
            continue;
          }
          throw new Exit2(`error: parse ${r.no}`);
        }
        flush();
        sections.push({ kind, path, moveTo, lines: [], chunks, lineNo });
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(cur);
    const lines = f.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTier(lines, ch.o, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos: number | null = null;
        for (const o of found.occ) {
          if (ch.eof && o + ch.o.length !== lines.length) continue;
          pos = o;
          break;
        }
        if (pos === null) throw new Fail('no-match', sec.path);
        const rep = ch.n.map((e) => (e.ctx !== null ? lines[pos! + e.ctx]! : reindentLine(e.text, ch.o, lines, pos!, found.tier)));
        lines.splice(pos, ch.o.length, ...rep);
        cursor = pos + ch.n.length;
      }
    }
    const text = joinFile({ br: f.br, lines, final: f.final });
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

/* The run: command line (section 1), output and exit codes (section 2), order and atomicity (section 10). */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const rPairs: Array<[string, string]> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) rPairs.push([o, n]);
  }
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
