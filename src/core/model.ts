/* nasjidwg — core document model.
 *
 * A neutral, JSON-friendly representation of a 2D/3D CAD drawing that both
 * the DXF and DWG codecs read into and write from. Every codec-specific
 * detail (group codes, bit layouts) stays inside the codecs; this model is
 * the single language of the library.
 */

export interface Point2 { x: number; y: number }
export interface Point3 { x: number; y: number; z: number }

/** Entity/table color. */
export type Color =
  | { kind: 'byLayer' }
  | { kind: 'byBlock' }
  | { kind: 'aci'; index: number }        /* AutoCAD Color Index 1..255 */
  | { kind: 'rgb'; rgb: number };         /* 0xRRGGBB true color */

export const BY_LAYER: Color = { kind: 'byLayer' };
export const BY_BLOCK: Color = { kind: 'byBlock' };

/** One extended-data value (DXF 1000-range group). Points use `point`. */
export type XdataValue =
  | { code: number; value: string | number }
  | { code: number; point: Point3 };

/** Extended entity data for one registered application. */
export interface XdataGroup {
  /** Registered application (APPID) name, when resolvable. */
  appName?: string;
  /** APPID handle as hex, kept when the name is not resolvable. */
  appHandle?: string;
  values: XdataValue[];
}

/** Properties shared by every entity. */
export interface EntityCommon {
  /** DWG/DXF handle as an uppercase hex string, when known. */
  handle?: string;
  layer: string;
  color: Color;
  /** Linetype name; undefined means ByLayer. */
  linetype?: string;
  /** Lineweight in millimeters (e.g. 0.25); undefined means ByLayer. */
  lineweight?: number;
  /** Linetype scale; undefined means 1. */
  linetypeScale?: number;
  /** True when the entity is invisible. */
  invisible?: boolean;
  /** Extrusion (the OCS normal), when it is not the default (0,0,1).
   *  Entities that store their geometry in object coordinates — circle,
   *  arc, ellipse, text, insert, solid, lwpolyline, hatch — carry their
   *  points in the plane this normal defines, so a consumer must map
   *  them to world coordinates through `ocsTransform`. A MIRROR command
   *  is the usual way a drawing ends up with (0,0,-1) here. */
  extrusion?: Point3;
  /** Extended data (XDATA/EED), retained per registered application. */
  xdata?: XdataGroup[];
  /** The raw DWG record, retained when the file was read with
   *  `retainRecords`. A handle-stable rewrite into the same encoding
   *  generation can emit these bytes verbatim — untouched entities then
   *  survive byte-for-byte, which is incremental-save fidelity without
   *  the incremental container.
   *
   *  THE CONTRACT. `record` asserts "these bytes still describe this
   *  entity". A writer asked for `{ preserveHandles: true,
   *  verbatimRecords: true }` TRUSTS that assertion and does not diff the
   *  bytes against the model, because doing so honestly would cost as
   *  much as re-encoding. So: a caller that changes an entity — its
   *  geometry, layer, colour, linetype, handle, or the space it lives in
   *  — MUST `delete entity.record`. Nothing else is required; the writer
   *  then re-encodes that entity from the model, and its neighbours stay
   *  byte-identical. Leaving a stale record in place writes the old
   *  entity back out.
   *
   *  The writer's own guards cover only what the model cannot say: bytes
   *  from a foreign encoding generation are never emitted as native,
   *  verbatim emission is switched off wholesale unless every symbol
   *  table kept its source handle, and entity kinds whose records reach
   *  past the tables into objects the writer mints fresh are always
   *  re-encoded. See DwgWriteOptions.verbatimRecords for the full list. */
  record?: SealedRecord;
}

/** The exact bytes of a DWG object record as the source file stored them
 *  (from the type field through the handle stream; the MS size prefix is
 *  not included — writers regenerate it). */
export interface SealedRecord {
  /** Record body, base64. */
  data: string;
  /** R2010+: bit length of the trailing handle stream, as the object
   *  map's size prefix stored it. */
  handleBits?: number;
  /** Encoding generation of the bytes: 14, 2000, 2004, 2007 or 2018. */
  encoding: number;
}

export interface LineEntity extends EntityCommon {
  type: 'line';
  start: Point3;
  end: Point3;
}

export interface PointEntity extends EntityCommon {
  type: 'point';
  position: Point3;
}

export interface CircleEntity extends EntityCommon {
  type: 'circle';
  center: Point3;
  radius: number;
}

export interface ArcEntity extends EntityCommon {
  type: 'arc';
  center: Point3;
  radius: number;
  /** Radians, counter-clockwise from +X. */
  startAngle: number;
  endAngle: number;
}

export interface EllipseEntity extends EntityCommon {
  type: 'ellipse';
  center: Point3;
  /** Endpoint of the major axis, relative to center. */
  majorAxis: Point3;
  /** minor/major radius ratio, 0 < ratio <= 1. */
  ratio: number;
  /** Parametric range in radians; full ellipse is 0..2π. */
  startParam: number;
  endParam: number;
}

export interface PolylineVertex extends Point2 {
  /** Arc bulge (tan of quarter included angle); 0/undefined = straight. */
  bulge?: number;
  startWidth?: number;
  endWidth?: number;
  /** Elevation of a 3D polyline vertex (heavy POLYLINE, flag 8). A
   *  vertex with a z makes the whole polyline a 3D one. */
  z?: number;
  /** Vertex identifier (DXF 91, R2010+): constraints and parametric
   *  actions name a vertex by it. 0 and absent are the same thing. */
  id?: number;
  /** Heavy POLYLINE only: the vertex was inserted by curve fitting
   *  (VERTEX 70 bit 1) — not one the user placed. */
  curveFit?: boolean;
  /** Heavy POLYLINE only: curve-fit tangent direction in radians
   *  (VERTEX 70 bit 2 with DXF 50). */
  tangent?: number;
}

export interface PolylineEntity extends EntityCommon {
  type: 'polyline';
  vertices: PolylineVertex[];
  closed: boolean;
  /** Constant width when set. */
  constantWidth?: number;
  elevation?: number;
  /** Set when the entity is a heavy POLYLINE — a header with its own
   *  VERTEX records and a SEQEND — rather than an inline LWPOLYLINE.
   *  '3d' is the 3D polyline (70 bit 8: vertices carry `z`); '2d' the
   *  planar one. Absent means LWPOLYLINE; a vertex with `z` is written
   *  heavy 3D regardless. */
  heavy?: '2d' | '3d';
  /** Heavy POLYLINE 70 bits 2/4 with 75: 'curve' = curve-fit (bit 2),
   *  'quadratic' / 'cubic' = spline-fit (bit 4, 75 = 5 / 6). `vertices`
   *  is what draws: the curve-fit vertices (inserted ones flagged
   *  `curveFit`) or the spline-fitted vertices (VERTEX 70 bit 8). */
  fit?: 'curve' | 'quadratic' | 'cubic';
  /** Spline-fit only: the frame control points the curve was fitted
   *  through (VERTEX 70 bit 16), kept apart from the drawn curve. */
  frame?: PolylineVertex[];
  /** 70 bit 128 (LWPOLYLINE 256 in the DWG record): the linetype
   *  pattern runs continuously around the vertices. */
  plineGen?: boolean;
}

export interface SplineEntity extends EntityCommon {
  type: 'spline';
  degree: number;
  closed: boolean;
  controlPoints: Point3[];
  knots: number[];
  weights?: number[];
  fitPoints?: Point3[];
}

/** Horizontal text justification. */
export type TextHAlign = 'left' | 'center' | 'right' | 'aligned' | 'middle' | 'fit';
export type TextVAlign = 'baseline' | 'bottom' | 'middle' | 'top';

export interface TextEntity extends EntityCommon {
  type: 'text';
  position: Point3;
  /** Second alignment point, meaningful when halign/valign are not defaults. */
  alignmentPoint?: Point3;
  text: string;                    /* logical order — Arabic stays logical here */
  height: number;
  rotation: number;                /* radians */
  widthFactor?: number;
  oblique?: number;
  style?: string;
  halign?: TextHAlign;
  valign?: TextVAlign;
  /** Present when the record was an attribute rather than a plain TEXT:
   *  'attdef' is the definition inside a block (DXF ATTDEF), 'attrib' a
   *  value carried by an insert (DXF ATTRIB). An invisible attribute
   *  (flags bit 1) also sets `invisible`, so a consumer that honours
   *  EntityCommon.invisible already skips it. */
  attribute?: 'attdef' | 'attrib';
  /** Attribute flags bit 2: a constant attribute — every insert shows
   *  the definition's own value unchanged. */
  constant?: boolean;
}

export interface MTextEntity extends EntityCommon {
  type: 'mtext';
  position: Point3;
  /** Plain text with \n line breaks (formatting codes stripped). */
  text: string;
  /** Raw MTEXT contents with inline codes, when the source had them. */
  raw?: string;
  height: number;
  rotation: number;
  /** Reference rectangle width; 0 = unbounded. */
  width?: number;
  /** Attachment point 1..9 (1 = top-left … 9 = bottom-right). */
  attachment?: number;
  style?: string;
}

export interface InsertEntity extends EntityCommon {
  type: 'insert';
  blockName: string;
  position: Point3;
  scale: Point3;
  rotation: number;                /* radians */
  /** Attached attribute values (already positioned in world space). */
  attributes?: TextEntity[];
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
}

/** One exact boundary edge of an edge-path hatch loop. */
export type HatchEdge =
  | { kind: 'line'; start: Point2; end: Point2 }
  | { kind: 'arc'; center: Point2; radius: number;
      startAngle: number; endAngle: number; ccw: boolean }
  | { kind: 'ellipticalArc'; center: Point2; majorAxis: Point2; ratio: number;
      startAngle: number; endAngle: number; ccw: boolean }
  | { kind: 'spline'; degree: number; periodic?: boolean;
      knots: number[]; controlPoints: Point2[]; weights?: number[];
      fitPoints?: Point2[] };

/** DXF 92 loop-type bits beyond the structural polyline bit: how the
 *  loop relates to the hatch. AutoCAD's audit needs them back — a
 *  style-1/2 (outer/ignore) hatch whose loops all lost their `external`
 *  bit cannot name its outer ring and is erased as unrepairable. */
export interface HatchLoopFlags {
  /** DXF 92 bit 1: the loop is the hatch's external boundary. */
  external?: boolean;
  /** DXF 92 bit 4: computed from a picked point (derived boundary). */
  derived?: boolean;
  /** DXF 92 bit 16: outermost loop. */
  outermost?: boolean;
  /** Soft-pointer handles (DXF 330) of the entities that generated this
   *  loop. Written back only when the hatch is associative — AutoCAD
   *  audits associative-with-no-boundary as an error on every such hatch. */
  boundaryHandles?: string[];
}

export type HatchBoundary = (
  | { kind: 'polyline'; vertices: PolylineVertex[]; closed: boolean }
  | { kind: 'circle'; center: Point2; radius: number }
  | { kind: 'ellipse'; center: Point2; majorAxis: Point2; ratio: number }
  /** Exact edge list (line/arc/ellipse/spline), kept unsampled. */
  | { kind: 'edges'; edges: HatchEdge[] }
) & HatchLoopFlags;

/** One pattern definition line (DXF 53/43,44/45,46/49*). */
export interface HatchDefLine {
  angle: number;                   /* degrees */
  base: Point2;
  offset: Point2;
  dashes: number[];
}

export interface HatchGradient {
  name: string;                    /* LINEAR, CYLINDER, SPHERICAL, ... */
  angle: number;
  shift: number;
  tint: number;
  singleColor: boolean;
  colors: { shift: number; color: Color }[];
}

export interface HatchEntity extends EntityCommon {
  type: 'hatch';
  patternName: string;             /* 'SOLID' for solid fill */
  solid: boolean;
  angle: number;                   /* degrees, as stored in the file */
  scale: number;
  loops: HatchBoundary[];
  elevation?: number;
  associative?: boolean;
  /** DXF 75: 0 normal (odd parity), 1 outer, 2 ignore islands. */
  styleFlag?: number;
  /** DXF 76: 0 user, 1 predefined, 2 custom. */
  patternType?: number;
  doubled?: boolean;
  /** Exact pattern definition lines when the source provided them. */
  definitionLines?: HatchDefLine[];
  gradient?: HatchGradient;
  seeds?: Point2[];
  /** DXF 47: derived-boundary pixel size (rides with `derived` loops). */
  pixelSize?: number;
}

export interface SolidEntity extends EntityCommon {
  type: 'solid';
  corners: [Point3, Point3, Point3, Point3];
}

export interface RayEntity extends EntityCommon {
  type: 'ray' | 'xline';
  basePoint: Point3;
  direction: Point3;               /* unit vector */
}

export interface LeaderEntity extends EntityCommon {
  type: 'leader';
  vertices: Point3[];
  hasArrowhead?: boolean;
  /** 0 straight segments, 1 spline. */
  pathType?: number;
  /** 0 text, 1 tolerance, 2 insert, 3 none. */
  annotationType?: number;
  /** Handle of the entity the leader annotates (an MTEXT, a TOLERANCE
   *  or an INSERT) — the association a CAD keeps when the text moves.
   *  Written when that entity is in the drawing; a leader whose
   *  annotation is gone goes out as annotating nothing. */
  annotation?: string;
}

export type DimensionKind =
  | 'linear' | 'aligned' | 'ordinate' | 'radius' | 'diameter'
  | 'angular3pt' | 'angular2ln' | 'arc';

export interface DimensionEntity extends EntityCommon {
  type: 'dimension';
  /** Which dimension this is; refines dimensionType. */
  kind?: DimensionKind;
  /** Name of the anonymous block holding the rendered geometry, if any. */
  blockName?: string;
  dimensionType: number;           /* DXF group 70 semantics */
  definitionPoint: Point3;         /* 10 */
  textMidpoint?: Point3;           /* 11 */
  insertionPoint?: Point3;         /* 12 */
  /** 13/14/15/16 — meaning depends on kind (xline pts, center, arc pt). */
  point13?: Point3;
  point14?: Point3;
  point15?: Point3;
  point16?: Point3;
  obliqueAngle?: number;           /* radians */
  /** Rotation of a rotated linear dimension (radians). */
  rotation?: number;
  leaderLength?: number;
  elevation?: number;
  measurement?: number;            /* 42 */
  text?: string;                   /* 1 — user override text */
  textRotation?: number;           /* radians */
  horizDirection?: number;         /* radians */
  attachment?: number;             /* 71 */
  lineSpacingStyle?: number;
  lineSpacingFactor?: number;
  style?: string;                  /* DIMSTYLE name */
}

export interface ViewportEntity extends EntityCommon {
  type: 'viewport';
  center: Point3;
  width: number;
  height: number;
  viewCenter?: Point2;
  viewHeight?: number;
  viewTarget?: Point3;
  viewDirection?: Point3;
  twistAngle?: number;             /* radians */
  lensLength?: number;
  statusFlag?: number;
  /** The viewport's number in its layout, as the reference counts them
   *  (DXF 69): 1 is the layout's own paper — the overall viewport, always
   *  on layer 0 — and the rest follow in file order. Kept so a rewrite
   *  puts the paper first again after the draw order has been applied
   *  to the array; the reference audits a layout whose first viewport is
   *  not its paper ("Paperspace vport layer Not 0"). */
  id?: number;
  frozenLayers?: string[];
}

export interface Face3DEntity extends EntityCommon {
  type: 'face3d';
  corners: [Point3, Point3, Point3, Point3];
  /** Bitmask of invisible edges (1,2,4,8). */
  invisibleEdges?: number;
}

export interface ShapeEntity extends EntityCommon {
  type: 'shape';
  position: Point3;
  size: number;
  rotation: number;                /* radians */
  widthFactor?: number;
  oblique?: number;                /* radians */
  /** Index of the shape in its SHX file (style table entry). */
  styleId?: number;
  /** Resolved text-style (shape file) name, when known. */
  style?: string;
  /** Shape name, when the source carried one (DXF group 2). */
  name?: string;
}

export interface ToleranceEntity extends EntityCommon {
  type: 'tolerance';
  position: Point3;
  xDirection: Point3;
  /** Feature control frame text (with {\Fgdt;...} codes as stored). */
  text: string;
}

export interface MLineLineData {
  /** Segment parameters along the element (DXF 41 values). */
  segparms: number[];
  areaFillParms?: number[];
}

export interface MLineVertex {
  position: Point3;
  direction: Point3;
  miterDirection: Point3;
  lines: MLineLineData[];
}

export interface MLineEntity extends EntityCommon {
  type: 'mline';
  styleName?: string;
  scale: number;
  /** 0 top, 1 zero/middle, 2 bottom. */
  justification: number;
  basePoint: Point3;
  closed?: boolean;
  vertices: MLineVertex[];
}

export interface MeshEntity extends EntityCommon {
  type: 'mesh';
  /** grid = PolylineMesh (m×n lattice); faces = PolylinePFace;
   *  subd = MESH, a subdivision surface. */
  meshKind: 'grid' | 'faces' | 'subd';
  vertices: Point3[];
  mSize?: number;
  nSize?: number;
  closedM?: boolean;
  closedN?: boolean;
  /** Faces as 1-based vertex indices; negative = invisible edge. */
  faces?: number[][];
  /** Subdivision surfaces: how far the surface is refined for display. */
  subdivisionLevel?: number;
  /** Subdivision surfaces: creased edges, as 1-based vertex-index pairs. */
  creases?: { from: number; to: number; weight: number }[];
}

/** An external reference drawn behind the geometry: a page of a PDF, a
 *  DGN model or a DWF sheet placed into the drawing. */
export interface UnderlayEntity extends EntityCommon {
  type: 'underlay';
  underlayKind: 'pdf' | 'dgn' | 'dwf';
  position: Point3;
  scale: Point3;
  rotation: number;                /* radians */
  /** File the shared definition object points at. */
  path?: string;
  /** Page (PDF), model (DGN) or sheet (DWF) name inside the file. */
  itemName?: string;
  /** DXF 280: 1 clipping, 2 on, 4 monochrome, 8 adjust for background. */
  flags?: number;
  contrast?: number;
  fade?: number;
  /** Clip boundary in underlay coordinates; 2 points = a rectangle. */
  clip?: Point2[];
}

export interface ImageEntity extends EntityCommon {
  type: 'image';
  /** True for WIPEOUT (masking image). */
  wipeout?: boolean;
  position: Point3;                /* lower-left insertion point */
  uVector: Point3;                 /* one-pixel step along image x */
  vVector: Point3;
  widthPx: number;
  heightPx: number;
  /** Image file path, resolved from IMAGEDEF when available. */
  path?: string;
  /** Clip boundary in image pixel space (2 pts = rectangle), stored as an
   *  open ring — the closing duplicate vertex DXF carries is dropped on
   *  read and restored on write. Pixel space is y-down: a clip vertex
   *  (cx, cy) sits at WCS
   *  `position + uVector*(cx+0.5) + vVector*(heightPx-0.5-cy)`.
   *  Wipeouts have widthPx = heightPx = 1, which makes their boundary a
   *  centered -0.5..+0.5 frame in that formula. */
  clip?: Point2[];
  /** R2010+ clip mode (DXF 290): the clip is inverted — the boundary
   *  hides what it encloses instead of revealing it. */
  clipInverted?: boolean;
  brightness?: number;
  contrast?: number;
  fade?: number;
}

/** One leader of a multileader: the polyline(s) that point at the note. */
export interface MLeaderLeader {
  /** Where the leader meets the content (the landing point). */
  landing?: Point3;
  /** Direction of the horizontal dogleg, when present. */
  doglegVector?: Point3;
  doglegLength?: number;
  /** Each leader line as its own point run. */
  lines: Point3[][];
}

/** MULTILEADER: leaders plus either text or a block as content. */
export interface MLeaderEntity extends EntityCommon {
  type: 'mleader';
  leaders: MLeaderLeader[];
  /** Text content, when the note is text. */
  text?: string;
  textPosition?: Point3;
  textHeight?: number;
  textRotation?: number;
  textStyle?: string;
  /** Block content, when the note is a block reference. */
  blockName?: string;
  blockPosition?: Point3;
  blockScale?: Point3;
  blockRotation?: number;
  /** Overall scale and the style name. */
  scale?: number;
  styleName?: string;
  arrowSize?: number;
  hasLanding?: boolean;
  hasDogleg?: boolean;
}

/** A light source (POINT/SPOT/DISTANT). */
export interface LightEntity extends EntityCommon {
  type: 'light';
  name?: string;
  /** 1 distant, 2 point, 3 spot. */
  lightType?: number;
  on?: boolean;
  intensity?: number;
  position: Point3;
  target?: Point3;
  lightColor?: Color;
  hotspotAngle?: number;
  falloffAngle?: number;
  castShadows?: boolean;
}

export interface TableCell {
  /** 1 text, 2 block. */
  contentType?: number;
  text?: string;
  /** Block name when the cell holds a block. */
  blockName?: string;
  textHeight?: number;
  /** How many columns/rows this cell spans. */
  spanColumns?: number;
  spanRows?: number;
  /** Attachment/alignment code as stored. */
  alignment?: number;
}

/** ACAD_TABLE: a grid of cells anchored at an insertion point. */
export interface TableEntity extends EntityCommon {
  type: 'table';
  position: Point3;
  direction?: Point3;
  numRows: number;
  numColumns: number;
  rowHeights: number[];
  columnWidths: number[];
  cells: TableCell[];
  /** Name of the block record holding the rendered geometry. */
  blockName?: string;
  styleName?: string;
}

/** Proxy graphics: the fallback vector image a producer stores so other
 *  programs can still draw an entity they do not understand. The decoded
 *  primitives are plain entities, so every renderer, exporter and
 *  geometry helper handles them without a special case.
 *
 *  Beyond the picture, the whole proxy is carried for passthrough: the
 *  original application class, the opaque application payload bit-exact,
 *  the cached display list byte-exact, and the record's own handle
 *  references. A drawing that arrives with a proxy leaves with the same
 *  proxy, so the owning application still recognizes its object after a
 *  round trip through this library. */
export interface ProxyEntity extends EntityCommon {
  type: 'proxy';
  /** Source class name, e.g. ACAD_PROXY_ENTITY or the original type. */
  sourceType: string;
  /** Decoded primitives, in draw order. */
  graphics: Entity[];
  /** The application class the proxy stands in for, as the source file's
   *  CLASSES section named it — re-emitted on write. */
  appClass?: { dxfName: string; cppName: string; appName: string };
  /** Format/version word(s) exactly as the record stored them. */
  proxyVersion?: number;
  /** R2018+ second version word (maintenance), when present. */
  proxyMaint?: number;
  /** True when the source recorded "originally from DXF". */
  fromDxf?: boolean;
  /** The opaque application payload, base64; `dataBits` is its exact
   *  length in bits (the stream is not byte-aligned). */
  data?: string;
  dataBits?: number;
  /** The raw cached display list, byte for byte, base64. `graphics` is
   *  its decoded form; this is what a rewrite emits. */
  graphicsData?: string;
  /** The proxy's own handle references (after the common entity ones),
   *  kept verbatim: reference code + hex handle value. */
  refs?: { code: number; value: string }[];
}

/** ACIS solid-modeling entity (REGION / 3DSOLID / BODY). The geometry
 *  kernel data is retained verbatim: SAT text (v1) or SAB binary (v2). */
export interface AcisEntity extends EntityCommon {
  type: 'acis';
  kind: 'region' | 'solid3d' | 'body' | 'surface';
  /** For `surface`, which flavour the file recorded. */
  surfaceKind?: 'plane' | 'extruded' | 'lofted' | 'revolved' | 'swept'
    | 'nurb';
  /** Display isolines across the surface, when the record carries them. */
  isolines?: { u: number; v: number };
  /** SAT text (R13-R2004 storage, deciphered to plain text). */
  sat?: string;
  /** SAB binary as base64 (R2007+ storage). */
  sab?: string;
}

/** An entity the codec recognized but does not model yet: kept, not lost.
 *  When the file cached a display list for it, `graphics` holds the
 *  drawable primitives so a viewer can still show the entity.
 *
 *  Universal passthrough: when the entity came from a DWG, the whole
 *  record is retained SEALED — payload bit-exact, R2007+ string stream
 *  verbatim, handle references code-for-code — and the writers re-emit
 *  it: natively when the target shares the payload's encoding generation,
 *  wrapped in a proxy record (the format's own idiom for foreign data)
 *  when it does not, and unwrapped back to a native record the next time
 *  the generations match. A drawing never loses what the library does
 *  not understand. */
export interface UnknownEntity extends EntityCommon {
  type: 'unknown';
  /** Source name, e.g. a DXF record name or DWG class dxfname. */
  sourceType: string;
  /** Decoded proxy graphics: plain entities in world coordinates. */
  graphics?: Entity[];
  /** The application class behind the record, when CLASSES named it. */
  appClass?: { dxfName: string; cppName: string; appName: string };
  /** Fixed DWG type number, when the record is not class-based. */
  typeCode?: number;
  /** Encoding generation of the sealed bits: 14, 2000, 2004, 2007, 2018. */
  encoding?: number;
  /** Sealed record payload, base64; exact bit length in dataBits. */
  data?: string;
  dataBits?: number;
  /** R2007+ string stream content, sealed the same way. */
  strData?: string;
  strBits?: number;
  /** Raw cached display list, byte for byte (decoded into `graphics`). */
  graphicsData?: string;
  /** Handle references after the common ones, kept verbatim. */
  refs?: { code: number; value: string }[];
  /** DXF-side sealed retention: the record's raw group/value tags,
   *  verbatim, when the entity arrived through DXF. The DXF writer
   *  re-emits them; the DWG writers cannot use them (different medium). */
  tags?: [number, string][];
}

/** A dictionary-side record the semantic layer does not model: retained
 *  sealed exactly like UnknownEntity, listed with its dictionary name. */
export interface UnknownObject {
  handle?: string;
  /** Name under which the owning dictionary lists it. */
  name?: string;
  sourceType: string;
  appClass?: { dxfName: string; cppName: string; appName: string };
  typeCode?: number;
  encoding?: number;
  data?: string;
  dataBits?: number;
  strData?: string;
  strBits?: number;
  refs?: { code: number; value: string }[];
  /** Handle of the source file's owner (hex) — recorded so a future
   *  rewrite can restore the original parent chain. */
  ownerHandle?: string;
  /** DXF-side sealed retention: raw tags, verbatim. */
  tags?: [number, string][];
  /** The record's own extended data (EED), decoded — the DXF tags carry
   *  it verbatim as well; this is the form the DWG writer can emit. */
  xdata?: XdataGroup[];
}

/** A point cloud placed in the drawing. The points themselves live in an
 *  external scan file; what the drawing stores is the placement, the
 *  extents and the name of that file. */
export interface PointCloudEntity extends EntityCommon {
  type: 'pointcloud';
  /** Scan file the cloud draws from, as the drawing recorded it. */
  fileName?: string;
  extentsMin: Point3;
  extentsMax: Point3;
  /** Coordinate frame the scan is placed in. */
  origin?: Point3;
  xAxis?: Point3;
  yAxis?: Point3;
  zAxis?: Point3;
  /** Number of points, when the record states it. */
  pointCount?: number;
  locked?: boolean;
  showIntensity?: boolean;
}

/** An embedded OLE object (OLE2FRAME / OLEFRAME): a placement frame plus
 *  the compound-document payload, which is kept verbatim. */
export interface OleEntity extends EntityCommon {
  type: 'ole';
  /** 1 = linked, 2 = embedded, 3 = static. */
  oleType: number;
  /** 0 = model space, 1 = paper space. */
  tileMode?: number;
  lockAspect?: boolean;
  /** Frame corners: upper-left, upper-right, lower-right, lower-left. */
  corners: [Point3, Point3, Point3, Point3];
  /** The embedded document bytes, exactly as stored. */
  data?: Uint8Array;
}

export type Entity =
  | LineEntity | PointEntity | CircleEntity | ArcEntity | EllipseEntity
  | PolylineEntity | SplineEntity | TextEntity | MTextEntity | InsertEntity
  | HatchEntity | SolidEntity | RayEntity | LeaderEntity | DimensionEntity
  | ViewportEntity | Face3DEntity | ShapeEntity | ToleranceEntity
  | MLineEntity | MeshEntity | ImageEntity | UnderlayEntity | AcisEntity
  | MLeaderEntity | LightEntity | TableEntity | ProxyEntity | OleEntity
  | PointCloudEntity | UnknownEntity;

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

export interface Layer {
  name: string;
  color: Color;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  plottable?: boolean;
  linetype?: string;
  lineweight?: number;
  /** Source-file handle (hex), kept so a handle-stable rewrite can
   *  preserve table numbering — raw entity records reference layers by
   *  handle, so this is what keeps retained records valid. */
  handle?: string;
  /** The record belongs to an external reference (its name is spelled
   *  `xref|layer`); it exists only while that file is attached. The DWG
   *  writers carry it only beside the block named before the bar when
   *  that block is written as an attachment (`BlockDefinition.xref`,
   *  R2000+), flagged dependent so the reference treats it as the
   *  attachment's own; with no such block it stays home — the reference
   *  audits an ordinary record with a bar in its name. */
  xrefDependent?: boolean;
}

export interface Linetype {
  name: string;
  description?: string;
  /** Dash/dot pattern: positive = dash, negative = gap, 0 = dot. */
  pattern: number[];
  /** Source-file handle (hex), for handle-stable rewrites. */
  handle?: string;
  /** Belongs to an external reference; see Layer.xrefDependent. */
  xrefDependent?: boolean;
}

export interface TextStyle {
  name: string;
  /** The font FILE, e.g. 'arial.ttf'. A name with no extension is an .shx. */
  font?: string;
  bigFont?: string;
  fixedHeight?: number;
  widthFactor?: number;
  /** Slant, in degrees. */
  oblique?: number;
  /** The TrueType TYPEFACE, which is where a TTF style really says its
   *  family: AutoCAD keeps the file in `font` and the family here, in the
   *  style record's ACAD xdata — and a style may leave the file empty and
   *  say all of it through this one. Read on both codecs; a rewrite carries
   *  the file name, so writing it back is still owed. */
  typeface?: string;
  /** A shape file (an .shx of shapes, not of a font) registered as a
   *  style record: the reference writes one named like a text style, so
   *  the flag is what tells the two "Standard" records apart. */
  shapeFile?: boolean;
  /** Belongs to an external reference; see Layer.xrefDependent. */
  xrefDependent?: boolean;
  bold?: boolean;
  italic?: boolean;
  /** Source-file handle (hex), for handle-stable rewrites. */
  handle?: string;
}

/** One named state of a dynamic block's visibility parameter. */
export interface BlockVisibilityState {
  name: string;
  /** Handles of the block's entities this state shows. */
  visible: string[];
}

/** One parametric definition inside a dynamic block. */
export interface BlockParameter {
  kind: 'linear' | 'rotation' | 'flip' | 'basePoint' | 'alignment'
    | 'xy' | 'polar' | 'point' | 'lookup';
  /** The element name of the parameter node. */
  name?: string;
  /** User-facing label (e.g. "Distance1", "Angle"). */
  label?: string;
  description?: string;
  firstPoint?: Point3;
  secondPoint?: Point3;
  /** rotation: the point the angle is measured to. */
  point?: Point3;
  /** flip: names of the two states. */
  baseStateName?: string;
  flippedStateName?: string;
  /** alignment: perpendicular rather than parallel. */
  perpendicular?: boolean;
  /** linear/rotation/xy/polar: the allowed value range, when constrained. */
  valueSet?: {
    type: number; minimum: number; maximum: number; increment: number;
    allowed: number[];
  };
  /** xy: the Y-axis label/description/range; polar: the angle's. */
  label2?: string;
  description2?: string;
  valueSet2?: BlockParameter['valueSet'];
}

export interface BlockDefinition {
  name: string;
  basePoint: Point3;
  entities: Entity[];
  /** The block is an attached external reference: its geometry lives in
   *  the file at `path` (as stored — absolute, relative or a bare name
   *  resolved against the drawing's folder and the search path), so
   *  `entities` is empty here. `overlay` is an overlaid attachment, which
   *  does not carry its own references along. A writer keeps the record
   *  as an xref, so the reference re-attaches the file on open. */
  xref?: { path: string; overlay?: boolean };
  /** True for layout blocks (*Model_Space / paper space). */
  isLayout?: boolean;
  /** Source-file BLOCK_HEADER handle (hex), for handle-stable rewrites. */
  handle?: string;
  /** Set when the block carries dynamic-block definition objects. */
  isDynamic?: boolean;
  /** The visibility parameter's user-facing name and prompt. */
  visibilityName?: string;
  visibilityPrompt?: string;
  /** Named visibility states, in the order the block defines them. */
  visibilityStates?: BlockVisibilityState[];
  /** The block's other parametric definitions (linear, flip, …). */
  parameters?: BlockParameter[];
  /** Action kinds the block defines (move, stretch, flip, …). */
  actions?: string[];
}

/** A named paper-space layout (DXF LAYOUT object). */
export interface Layout {
  name: string;
  /** Tab order in the CAD UI. */
  tabOrder?: number;
  /** Name of the block record holding this layout's entities. */
  blockName?: string;
  limMin?: Point2;
  limMax?: Point2;
  extMin?: Point3;
  extMax?: Point3;
  insBase?: Point3;
  /** Plot settings that survive a round trip. */
  paperSize?: string;
  plotStyleSheet?: string;
}

/** A named group of entities (DXF GROUP object). */
export interface Group {
  name: string;
  description?: string;
  selectable?: boolean;
  /** Handles of the member entities (hex, matching Entity.handle). */
  entityHandles: string[];
}

export interface MLineStyleElement {
  offset: number;
  color: Color;
  linetype?: string;
}

/** A multiline style (DXF MLINESTYLE object). */
export interface MLineStyle {
  name: string;
  description?: string;
  flags?: number;
  fillColor?: Color;
  startAngle?: number;             /* radians */
  endAngle?: number;
  elements: MLineStyleElement[];
}

/** A named UCS (DXF UCS table record). */
export interface Ucs {
  name: string;
  origin: Point3;
  xAxis: Point3;
  yAxis: Point3;
}

/** A named view (DXF VIEW table record). */
export interface View {
  name: string;
  center: Point2;
  height: number;
  width: number;
  direction?: Point3;
  target?: Point3;
  lensLength?: number;
}

/** A viewport configuration (DXF VPORT table record). */
export interface VPort {
  name: string;
  lowerLeft: Point2;
  upperRight: Point2;
  center: Point2;
  height: number;
  /** DXF group 41: the view aspect ratio, width / height. (The DWG record
   *  itself stores the view width; the readers and writers convert at that
   *  boundary, so this field always speaks DXF.) */
  aspectRatio?: number;
  direction?: Point3;
  target?: Point3;
  snapBase?: Point2;
  snapSpacing?: Point2;
  gridSpacing?: Point2;
  /** VIEWTWIST, in radians. The view is drawn rotated by this much, so a
   *  drawing laid out at an angle in model space still reads square on
   *  screen — a consumer that ignores it shows the model tilted. */
  twist?: number;
  lensLength?: number;
  frontClip?: number;
  backClip?: number;
  viewMode?: number;
  circleSides?: number;
  fastZoom?: boolean;
  /** UCSICON: bit 0 the icon is on, bit 1 it sits at the origin. */
  ucsIcon?: number;
  /** UCSFOLLOW. DXF folds it into group 71 as bit 8. */
  ucsFollow?: boolean;
  gridOn?: boolean;
  snapOn?: boolean;
  snapStyle?: number;
  snapIsoPair?: number;
  snapAngle?: number;
  /** The viewport's own UCS (R2000+ carries it in the record itself). */
  ucsOrigin?: Point3;
  ucsXAxis?: Point3;
  ucsYAxis?: Point3;
  ucsElevation?: number;
  ucsOrthoType?: number;
  /** UCSVP: whether the viewport keeps its own UCS. */
  ucsPerViewport?: boolean;
  renderMode?: number;
}

/** The drawing's current coordinate system, from the header's UCSORG /
 *  UCSXDIR / UCSYDIR. A rotated UCS is how a drawing comes to sit at an
 *  angle in model space, so a consumer that drops it draws the model
 *  turned. */
export interface HeaderUcs {
  origin: Point3;
  xAxis: Point3;
  yAxis: Point3;
}

/** A dictionary-owned proxy object (ACAD_PROXY_OBJECT): the non-entity
 *  twin of ProxyEntity. An application object nobody else can interpret,
 *  retained whole — class, version, opaque payload bit-exact and handle
 *  references — and written back under the named objects dictionary. */
export interface ProxyObject {
  /** Handle of the record itself (hex). */
  handle?: string;
  /** Name under which the owning dictionary lists it. */
  name?: string;
  /** Handle of the source file's owner (hex), recorded so a future
   *  rewrite can restore the original parent chain. */
  ownerHandle?: string;
  /** Original class DXF name, when the source file's CLASSES named it. */
  sourceType?: string;
  appClass?: { dxfName: string; cppName: string; appName: string };
  proxyVersion?: number;
  proxyMaint?: number;
  fromDxf?: boolean;
  /** Opaque application payload, base64; exact bit length in dataBits. */
  data?: string;
  dataBits?: number;
  refs?: { code: number; value: string }[];
  /** The record's own extended data (EED), per registered application.
   *  Some applications keep a proxy object's whole content here — the
   *  database-link records of the reference's dbConnect sample carry
   *  nothing but their DCO15 xdata — so it travels with the record. */
  xdata?: XdataGroup[];
}

/** An extension-dictionary XRECORD: an ordered list of typed group values
 *  the producing application owns. Retained verbatim so a round trip does
 *  not lose application data. */
export interface XRecord {
  /** Handle of the record itself (hex). */
  handle?: string;
  /** Name under which the owning dictionary lists this record. */
  name?: string;
  values: XdataValue[];
}

/** A dimension style (DXF DIMSTYLE table record). */
export interface DimStyle {
  name: string;
  /** Variables by name (DIMSCALE, DIMTXT, …) when decoded. */
  vars?: Record<string, number | string | boolean>;
}

/* ------------------------------------------------------------------ *
 * Header + document
 * ------------------------------------------------------------------ */

export type FileVersion =
  | 'R1.1' | 'R1.2' | 'R1.3' | 'R1.4'
  | 'R2.0' | 'R2.10' | 'R2.21' | 'R2.22' | 'R2.4' | 'R2.5' | 'R2.6'
  | 'R9' | 'R10' | 'R12'
  | 'R13' | 'R14' | 'R2000' | 'R2004' | 'R2007' | 'R2010' | 'R2013' | 'R2018';

export interface Header {
  version?: FileVersion;
  codepage?: string;
  insUnits?: number;
  extMin?: Point3;
  extMax?: Point3;
  limMin?: Point2;
  limMax?: Point2;
  linetypeScale?: number;
  /** The current UCS (model space), and the paper-space one beside it. */
  ucs?: HeaderUcs;
  pUcs?: HeaderUcs;
  /** Anything else read from the source header, keyed by variable name. */
  vars?: Record<string, unknown>;
  /** Document summary properties (title, author, custom fields). */
  summary?: {
    title?: string; subject?: string; author?: string; keywords?: string;
    comments?: string; lastSavedBy?: string; revisionNumber?: string;
    hyperlinkBase?: string;
    custom?: { tag: string; value: string }[];
  };
  /** Embedded preview image, when the file carries one. */
  thumbnail?: { format: 'bmp' | 'wmf' | 'png'; data: Uint8Array };
}

export interface Drawing {
  header: Header;
  layers: Layer[];
  linetypes: Linetype[];
  textStyles: TextStyle[];
  blocks: Record<string, BlockDefinition>;
  entities: Entity[];              /* model space */
  paperSpace?: Entity[];
  /** Named paper-space layouts, in tab order when known. */
  layouts?: Layout[];
  /** Named entity groups. */
  groups?: Group[];
  /** Multiline styles referenced by MLINE entities. */
  mlineStyles?: MLineStyle[];
  /** Named coordinate systems. */
  ucs?: Ucs[];
  /** Named views. */
  views?: View[];
  /** Viewport configurations. */
  vports?: VPort[];
  /** Dimension styles. */
  dimStyles?: DimStyle[];
  /** Registered application names (APPID table). */
  appIds?: string[];
  /** XRECORD objects, retained with their dictionary names. */
  xrecords?: XRecord[];
  /** Dictionary-owned proxy objects, retained whole for passthrough. */
  proxyObjects?: ProxyObject[];
  /** Every other unmodeled object, retained sealed for passthrough. */
  unknownObjects?: UnknownObject[];
  /** Geographic location data (GEODATA), when the drawing is placed. */
  geoData?: GeoData;
  /** Non-fatal problems encountered while reading. */
  warnings: string[];
}

/** Geographic location data: how design coordinates sit on the earth. */
export interface GeoData {
  /** Object version: 1 = 2009, 2 = 2010, 3 = 2013. */
  version?: number;
  /** 0 unknown, 1 local grid, 2 projected grid, 3 geographic. */
  coordinatesType?: number;
  /** Anchor in design (WCS) coordinates. */
  designPoint: Point3;
  /** The same anchor in coordinate-system coordinates. */
  referencePoint: Point3;
  /** North direction in design space. */
  northDirection?: Point2;
  /** Multiplying a horizontal design distance by this yields meters. */
  horizontalUnitScale?: number;
  verticalUnitScale?: number;
  horizontalUnits?: number;
  verticalUnits?: number;
  upDirection?: Point3;
  scaleEstimation?: number;
  userScaleFactor?: number;
  seaLevelCorrection?: boolean;
  seaLevelElevation?: number;
  projectionRadius?: number;
  /** Coordinate system definition (WKT for 2009, map-guide XML later). */
  coordinateSystem?: string;
  /** GeoRSS tag, e.g. "<georss:point>55.844 -4.231</georss:point>". */
  geoRssTag?: string;
  /** Anchor latitude/longitude in degrees, parsed from the GeoRSS tag. */
  latitude?: number;
  longitude?: number;
}

/** A fresh, valid, empty drawing. */
export const emptyDrawing = (): Drawing => ({
  header: {},
  layers: [{
    name: '0', color: { kind: 'aci', index: 7 },
    on: true, frozen: false, locked: false
  }],
  linetypes: [{ name: 'Continuous', description: 'Solid line', pattern: [] }],
  textStyles: [{ name: 'Standard' }],
  blocks: {},
  entities: [],
  warnings: []
});
