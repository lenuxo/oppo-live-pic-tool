import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import type { Segment } from './jpeg.js';
import { PhotoError, type Patch } from '../core/types.js';
const STANDARD = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
const EXTENDED = Buffer.from('http://ns.adobe.com/xmp/extension/\0');
const CAMERA = 'http://ns.google.com/photos/1.0/camera/';
const CONTAINER = 'http://ns.google.com/photos/1.0/container/';
const OPLUS = 'http://ns.oplus.com/photos/1.0/camera/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ITEM = 'http://ns.google.com/photos/1.0/container/item/';
type Node = { [key: string]: unknown };
type NS = Record<string, string>;
interface Item { Mime?: string; Semantic?: string; Length?: string; Padding?: string }
export interface Xmp { items: Item[]; hasMotion: boolean; patches: Patch[]; extended: boolean; oplusVersion?: string; oplusVideoLength?: string; oplusOwner?: string }
function namespace(attrs: Record<string, string>, inherited: NS): NS {
  const ns = { ...inherited };
  for (const [key, value] of Object.entries(attrs)) {
    if (key === '@_xmlns') ns[''] = value;
    else if (key.startsWith('@_xmlns:')) ns[key.slice(8)] = value;
  }
  return ns;
}
function name(q: string, ns: NS, attribute = false): [string, string] {
  const i = q.indexOf(':');
  return i < 0 ? [attribute ? '' : (ns[''] ?? ''), q] : [ns[q.slice(0, i)] ?? '', q.slice(i + 1)];
}
const cameraField = (uri: string, local: string) => (uri === CAMERA && ['MotionPhoto', 'MotionPhotoVersion', 'MotionPhotoPresentationTimestampUs', 'MicroVideo', 'MicroVideoVersion', 'MicroVideoOffset', 'MicroVideoPresentationTimestampUs'].includes(local)) || (uri === OPLUS && ['MotionPhotoPrimaryPresentationTimestampUs', 'MotionPhotoOwner', 'OLivePhotoVersion', 'VideoLength'].includes(local));
function scalar(nodes: Node[]): string {
  if (nodes.some(n => Object.keys(n).some(k => k !== '#text' && k !== ':@'))) throw new PhotoError('UNSUPPORTED_XMP', '实况字段的复合 XML 写法暂不支持');
  return nodes.map(n => n['#text'] ?? '').join('').trim();
}
export function parseXmp(segments: Segment[]): Xmp {
  const result: Xmp = { items: [], hasMotion: false, patches: [], extended: false };
  let directories = 0, packets = 0;
  for (const seg of segments) {
    if (seg.data.subarray(0, EXTENDED.length).equals(EXTENDED)) { result.extended = true; continue; }
    if (!seg.data.subarray(0, STANDARD.length).equals(STANDARD)) continue;
    if (++packets > 1) throw new PhotoError('UNSUPPORTED_XMP', '多个标准 XMP 数据包暂不支持');
    const xml = seg.data.subarray(STANDARD.length).toString('utf8').replace(/\0+$/, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new PhotoError('INVALID_XMP', 'XMP XML 无效或包含不支持的声明');
    const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(xml) as Node[];
    let changed = false, visited = 0;
    function cameraValue(uri: string, local: string, raw: string) {
      const value = raw.trim();
      if (uri === CAMERA && ['MotionPhoto', 'MicroVideo'].includes(local)) {
        if (!['0', '1'].includes(value)) throw new PhotoError('INVALID_XMP_FLAG', '实况开关必须为 0 或 1');
        if (value === '1') result.hasMotion = true;
      }
      if (uri === OPLUS) {
        const field = { OLivePhotoVersion: 'oplusVersion', VideoLength: 'oplusVideoLength', MotionPhotoOwner: 'oplusOwner' }[local] as 'oplusVersion' | 'oplusVideoLength' | 'oplusOwner' | undefined;
        if (field) {
          if (result[field] !== undefined && result[field] !== value) throw new PhotoError('INVALID_XMP', '重复的 Oplus 字段值不一致');
          result[field] = value;
        }
      }
    }
    function visit(nodes: Node[], inherited: NS, inDirectory = false, depth = 0): Node[] {
      if (depth > 128) throw new PhotoError('METADATA_LIMIT', 'XMP 嵌套深度超过限制');
      return nodes.filter(node => {
        if (++visited > 10000) throw new PhotoError('METADATA_LIMIT', 'XMP 节点过多');
        const attrs = (node[':@'] ?? {}) as Record<string, string>;
        const ns = namespace(attrs, inherited);
        const tag = Object.keys(node).find(k => k !== ':@');
        if (!tag || !Array.isArray(node[tag])) return true;
        const [uri, local] = name(tag, ns);
        const isDirectory = uri === CONTAINER && local === 'Directory';
        if (isDirectory) directories++;
        let videoItem = false;
        if (inDirectory && uri === CONTAINER && local === 'Item') {
          const item: Item = {};
          for (const [key, value] of Object.entries(attrs)) {
            const [aUri, aLocal] = name(key.slice(2), ns, true);
            if (aUri === ITEM && ['Mime', 'Semantic', 'Length', 'Padding'].includes(aLocal)) item[aLocal as keyof Item] = String(value).trim();
          }
          for (const child of node[tag] as Node[]) {
            const key = Object.keys(child).find(k => k !== ':@');
            if (!key) continue;
            const childNs = namespace((child[':@'] ?? {}) as Record<string, string>, ns);
            const [cUri, cLocal] = name(key, childNs);
            if (cUri === ITEM && ['Mime', 'Semantic', 'Length', 'Padding'].includes(cLocal) && Array.isArray(child[key])) {
              const value = scalar(child[key] as Node[]);
              if (item[cLocal as keyof Item] !== undefined && item[cLocal as keyof Item] !== value) throw new PhotoError('INVALID_XMP', '容器条目字段值不一致');
              item[cLocal as keyof Item] = value;
            }
          }
          result.items.push(item);
          videoItem = item.Semantic === 'MotionPhoto' && item.Mime === 'video/mp4';
        }
        for (const key of Object.keys(attrs)) {
          const [aUri, aLocal] = name(key.slice(2), ns, true);
          if (cameraField(aUri, aLocal)) { cameraValue(aUri, aLocal, String(attrs[key])); delete attrs[key]; changed = true; }
        }
        if (cameraField(uri, local)) {
          cameraValue(uri, local, scalar(node[tag] as Node[]));
          changed = true; return false;
        }
        node[tag] = visit(node[tag] as Node[], ns, inDirectory || isDirectory, depth + 1);
        if (videoItem) { result.hasMotion = true; changed = true; return false; }
        if (inDirectory && uri === RDF && local === 'li' && (node[tag] as Node[]).every(n => Object.keys(n).length === 1 && typeof n['#text'] === 'string' && !(n['#text'] as string).trim())) { changed = true; return false; }
        if (isDirectory && !result.items.some(i => i.Semantic === 'GainMap') && result.items.some(i => i.Semantic === 'MotionPhoto')) { changed = true; return false; }
        return true;
      });
    }
    const cleaned = visit(tree, {});
    if (changed) {
      const body = Buffer.concat([STANDARD, Buffer.from(new XMLBuilder({ preserveOrder: true, ignoreAttributes: false }).build(cleaned))]);
      if (body.length + 2 > 65535) throw new PhotoError('XMP_TOO_LARGE', '清理后的 XMP 超过 JPEG segment 限制');
      const header = Buffer.alloc(4); header[0] = 0xff; header[1] = 0xe1; header.writeUInt16BE(body.length + 2, 2);
      result.patches.push({ offset: seg.start, length: seg.end - seg.start, bytes: Buffer.concat([header, body]) });
    }
  }
  if (directories > 1) throw new PhotoError('UNSUPPORTED_XMP', '多个 XMP 容器目录暂不支持');
  return result;
}
export function integer(value: string | undefined, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!value || !/^\d+$/.test(value)) throw new PhotoError('INVALID_XMP_LENGTH', 'XMP 长度或填充字段无效');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new PhotoError('INVALID_XMP_LENGTH', 'XMP 长度超出可安全寻址范围');
  return n;
}
