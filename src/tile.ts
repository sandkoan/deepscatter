import { extent } from 'd3-array';

import {
  Table,
  Vector,
  Utf8,
  Float32,
  Float,
  Int,
  Uint32,
  Int32,
  Int64,
  Dictionary,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  makeBuilder,
  makeVector,
  RecordBatch,
  Schema,
  Data,
  Field,
  StructRowProxy,
} from 'apache-arrow';
import { add_or_delete_column } from './Dataset';
import type { Dataset, QuadtileSet } from './Dataset';
type MinMax = [number, number];

export type Rectangle = {
  x: MinMax;
  y: MinMax;
};

interface schema_entry {
  name: string;
  type: string;
  extent: Array<any>;
  keys?: Array<any>;
}

import type { TileBufferManager } from './regl_rendering';
// Keep a global index of tile numbers. These are used to identify points.
let tile_identifier = 0;

/**
 * A Tile is, essentially, code to create an Arrow RecordBatch
 * and to associate metadata with it, in the context of a larger dataset.
 *
 */
export abstract class Tile {
  public max_ix = -1;
  readonly key: string; // A unique identifier for this tile.
  promise: Promise<void>;
  download_state: string;
  public _batch?: RecordBatch;
  parent: this | null;
  _table_buffer?: ArrayBuffer;
  public _children: Array<this> = [];
  public _highest_known_ix?: number;
  public _min_ix?: number;
  public _max_ix?: number;
  public dataset: Dataset<this>;
  public _download?: Promise<void>;
  __schema?: schema_entry[];
  local_dictionary_lookups?: Map<string, any>;
  public _extent?: { x: MinMax; y: MinMax };
  public numeric_id: number;
  // bindings to regl buffers holdings shadows of the RecordBatch.
  public _buffer_manager?: TileBufferManager<this>;
  constructor(dataset: Dataset<this>) {
    // Accepts prefs only for the case of the root tile.
    this.promise = Promise.resolve();
    this.download_state = 'Unattempted';
    this.key = String(Math.random());
    this.parent = null;
    this.dataset = dataset;
    if (dataset === undefined) {
      throw new Error('No dataset provided');
    }
    // Grab the next identifier off the queue. This should be async safe with the current setup, but
    // the logic might fall apart in truly parallel situations.
    this.numeric_id = tile_identifier++;
  }

  get children() {
    return this._children;
  }

  get dictionary_lookups() {
    return this.dataset.dictionary_lookups;
  }

  download() {
    throw new Error('Not implemented');
  }

  delete_column_if_exists(colname: string) {
    if (this._batch) {
      this._buffer_manager?.release(colname);
      this._batch = add_or_delete_column(this.record_batch, colname, null);
    }
  }

  async apply_transformation(name: string): Promise<void> {
    const transform = this.dataset.transformations[name];
    if (transform === undefined) {
      throw new Error(`Transformation ${name} is not defined`);
    }
    const transformed = await transform(this);
    if (transformed === undefined) {
      throw new Error(`Transformation ${name} failed`);
    }
    this._batch = add_or_delete_column(this.record_batch, name, transformed);
  }

  add_column(name: string, data: Float32Array) {
    this._batch = add_or_delete_column(this.record_batch, name, data);
    return this._batch;
  }

  is_visible(max_ix: number, viewport_limits: Rectangle | undefined): boolean {
    // viewport_limits is in coordinate points.
    // Will typically be got by calling current_corners.

    // Top tile is always visible (even if offscreen).
    // if (!this.parent) {return true}
    if (this.min_ix === undefined) {
      return false;
    }

    if (this.min_ix > max_ix) {
      return false;
    }
    if (viewport_limits === undefined) {
      return true;
    }

    const c = this.extent;
    return !(
      c.x[0] > viewport_limits.x[1] ||
      c.x[1] < viewport_limits.x[0] ||
      c.y[0] > viewport_limits.y[1] ||
      c.y[1] < viewport_limits.y[0]
    );
  }

  *points(
    bounding: Rectangle | undefined,
    sorted = false
  ): Iterable<StructRowProxy> {
    //if (!this.is_visible(1e100, bounding)) {
    //  return;
    //}
    for (const p of this) {
      if (p_in_rect([p.x as number, p.y as number], bounding)) {
        yield p;
      }
    }
    //    console.log("Exhausted points on ", this.key)
    if (sorted === false) {
      for (const child of this.children) {
        if (!child.ready) {
          continue;
        }
        if (bounding && !child.is_visible(1e100, bounding)) {
          continue;
        }
        for (const p of child.points(bounding, sorted)) {
          if (p_in_rect([p.x as number, p.y as number], bounding)) {
            yield p;
          }
        }
      }
    } else {
      let children = this.children.map((tile) => {
        const f = {
          t: tile,
          iterator: tile.points(bounding, sorted),
          next: undefined,
        };
        f.next = f.iterator.next();
        return f;
      });
      children = children.filter((d) => d?.next?.value);
      while (children.length > 0) {
        let mindex = 0;
        for (let i = 1; i < children.length; i++) {
          if (children[i].next.value.ix < children[mindex].next.value.ix) {
            mindex = i;
          }
        }
        yield children[mindex].next.value;
        children[mindex].next = children[mindex].iterator.next();
        if (children[mindex].next.done) {
          children = children.splice(mindex, 1);
        }
      }
    }
  }

  forEach(callback: (p: StructRowProxy) => void) {
    for (const p of this.points(undefined, false)) {
      if (p === undefined) {
        continue;
      }
      callback(p);
    }
  }

  set highest_known_ix(val) {
    // Do nothing if it isn't actually higher.
    if (this._highest_known_ix == undefined || this._highest_known_ix < val) {
      this._highest_known_ix = val;
      if (this.parent) {
        // bubble value to parent.
        this.parent.highest_known_ix = val;
      }
    }
  }

  get highest_known_ix(): number {
    return this._highest_known_ix || -1;
  }

  get record_batch() {
    if (this._batch) {
      return this._batch;
    }
    // Constitute table if there's a present buffer.
    if (this._table_buffer && this._table_buffer.byteLength > 0) {
      return (this._batch = tableFromIPC(this._table_buffer).batches[0]);
    }
    throw new Error('Attempted to access table on tile without table buffer.');
  }

  get min_ix() {
    if (this._min_ix !== undefined) {
      return this._min_ix;
    }
    if (this.parent) {
      return this.parent.max_ix + 1;
    }
    return 0;
  }

  async schema() {
    await this.download();
    return this._schema;
  }

  /**
   *
   * @param callback A function (possibly async) to execute before this cell is ready.
   * @returns A promise that includes the callback and all previous promises.
   */
  extend_promise(callback: () => Promise<void>) {
    this.promise = this.promise.then(() => callback());
    return this.promise;
  }

  get ready(): boolean {
    // The flag for readiness is whether there is
    // an arraybuffer at this._table_buffer

    // Unlike 'promise,' this returns asychronously
    return (
      this._table_buffer !== undefined && this._table_buffer.byteLength > 0
    );
  }

  protected get _schema() {
    // Infer datatypes from the first file.
    if (this.__schema) {
      return this.__schema;
    }
    const attributes: schema_entry[] = [];
    for (const field of this.record_batch.schema.fields) {
      const { name, type } = field;
      if (type?.typeId == 5) {
        // character
        attributes.push({
          name,
          type: 'string',
          extent: [],
        });
      }
      if (type && type.dictionary) {
        attributes.push({
          name,
          type: 'dictionary',
          keys: this.record_batch.getChild(name).data[0].dictionary.toArray(),
          extent: [
            -2047,
            this.record_batch.getChild(name).data[0].dictionary.length - 2047,
          ],
        });
      }
      if (type && type.typeId == 8) {
        attributes.push({
          name,
          type: 'date',
          extent: extent(this.record_batch.getChild(name).data[0].values),
        });
      }
      if (type?.typeId === 10) {
        // MUST HANDLE RESOLUTIONS HERE.
        return [10, 100];
        attributes.push({
          name,
          type: 'datetime',
          extent: this.dataset.domain(name),
        });
      }
      if (type && type.typeId == 3) {
        attributes.push({
          name,
          type: 'float',
          extent: extent(this.record_batch.getChild(name).data[0].values),
        });
      }
    }
    this.__schema = attributes;
    return attributes;
  }

  *yielder() {
    for (const row of this.record_batch) {
      if (row) {
        yield row;
      }
    }
  }

  get extent(): Rectangle {
    if (this._extent) {
      return this._extent;
    }
    return {
      x: [Number.MIN_VALUE, Number.MAX_VALUE],
      y: [Number.MIN_VALUE, Number.MAX_VALUE],
    };
  }

  [Symbol.iterator](): IterableIterator<StructRowProxy> {
    return this.yielder();
  }

  get root_extent(): Rectangle {
    if (this.parent === null) {
      // infinite extent
      return {
        x: [Number.MIN_VALUE, Number.MAX_VALUE],
        y: [Number.MIN_VALUE, Number.MAX_VALUE],
      };
    }
    return this.parent.root_extent;
  }
}

export class QuadTile extends Tile {
  url: string;
  bearer_token = '';
  key: string;
  public _children: Array<this> = [];
  codes: [number, number, number];
  _already_called = false;
  public child_locations: string[] = [];
  constructor(
    base_url: string,
    key: string,
    parent: QuadTile | null,
    dataset: QuadtileSet,
    prefs: APICall
  ) {
    super(dataset);
    this.url = base_url;
    this.bearer_token = prefs?.bearer_token ?? '';

    this.parent = parent as this;
    this.key = key;
    const [z, x, y] = key.split('/').map((d) => Number.parseInt(d));
    this.codes = [z, x, y];
  }

  get extent(): Rectangle {
    if (this._extent) {
      return this._extent;
    }
    return this.theoretical_extent;
  }

  async download_to_depth(max_ix: number): Promise<void> {
    /**
     * Recursive fetch all tiles up to a certain depth. Triggers many unnecessary calls: prefer
     * download instead if possible.
     */
    await this.download();
    let promises: Array<Promise<void>> = [];
    if (this.max_ix < max_ix) {
      promises = this.children.map((child) => child.download_to_depth(max_ix));
    }
    await Promise.all(promises);
  }

  async download(): Promise<void> {
    // This should only be called once per tile.
    if (this._download) {
      return this._download;
    }

    if (this._already_called) {
      throw 'Illegally attempting to download twice';
    }

    this._already_called = true;
    let url = `${this.url}/${this.key}.feather`;
    this.download_state = 'In progress';

    if (this.bearer_token) {
      url = url.replace('/public', '');
    }

    const request: RequestInit | undefined = this.bearer_token
      ? {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + this.bearer_token },
        }
      : undefined;

    this._download = fetch(url, request)
      .then(async (response): Promise<void> => {
        const buffer = await response.arrayBuffer();
        this.download_state = 'Complete';
        this._table_buffer = buffer;
        this._batch = tableFromIPC(buffer).batches[0];
        const metadata = this._batch.schema.metadata;
        const extent = metadata.get('extent');
        if (extent) {
          this._extent = JSON.parse(extent) as Rectangle;
        }
        const children = metadata.get('children');
        if (children) {
          this.child_locations = JSON.parse(children) as string[];
        }
        const ixes = this._batch.getChild('ix');
        if (ixes === null) {
          throw 'No ix column in table';
        }
        this._min_ix = Number(ixes.get(0));
        this.max_ix = Number(ixes.get(ixes.length - 1));
        if (this._min_ix > this.max_ix) {
          this.max_ix = this._min_ix + 1e5;
          this._min_ix = 0;
        }
        this.highest_known_ix = this.max_ix;
      })
      .catch((error) => {
        this.download_state = 'Failed';
        console.error(`Error: Remote Tile at ${this.url}/${this.key}.feather not found.
        `);
        console.warn(error);
        throw error;
      });
    return this._download;
  }

  /** 
   * Sometimes it's useful to do operations on batches of tiles. This function
   * defines a grouping of tiles in the same general region to be operated on.
   * In general they will have about 80 elements (16 + 64), but the top level
   * has just 5. (4 + 1). Note a macro tile with the name [2/0/0] does not actually include
   * the tile [2/0/0] itself, but rather the tiles [4/0/0], [4/1/0], [4/0/1], [4/1/1], [5/0/0] etc.
   */
  get macrotile() : string {
    return macrotile(this.key);
  }

  get macro_siblings() : Array<string> {
   return macrotile_siblings(this.key);
  }

  get children(): Array<this> {
    // create or return children.

    if (this.download_state !== 'Complete') {
      return [];
    }
    const constructor = this.constructor as new (
      k: string,
      l: string,
      m: this,
      data: typeof this.dataset,
      prefs: APICall
    ) => this;
    if (this._children.length < this.child_locations.length) {
      for (const key of this.child_locations) {
        const child = new constructor(this.url, key, this, this.dataset, {
          bearer_token: this.bearer_token,
        });
        this._children.push(child);
      }
    }
    return this._children;
  }

  get theoretical_extent(): Rectangle {
    // QUADTREE SPECIFIC CODE.
    const base = this.dataset.extent;
    const [z, x, y] = this.codes;

    const x_step = base.x[1] - base.x[0];
    const each_x = x_step / 2 ** z;

    const y_step = base.y[1] - base.y[0];
    const each_y = y_step / 2 ** z;

    return {
      x: [base.x[0] + x * each_x, base.x[0] + (x + 1) * each_x],
      y: [base.y[0] + y * each_y, base.y[0] + (y + 1) * each_y],
    };
  }
}

export class ArrowTile extends Tile {
  batch_num: number;
  full_tab: Table;
  constructor(
    table: Table,
    dataset: Dataset<ArrowTile>,
    batch_num: number,
    parent = null
  ) {
    super(dataset);
    this.full_tab = table;
    this._batch = table.batches[batch_num];
    this.download_state = 'Complete';
    this.batch_num = batch_num;
    // On arrow tables, it's reasonable to just add a new index by order.
    if (this._batch.getChild('ix') === null) {
      console.warn('Manually setting ix');
      const batch = this._batch;
      const array = new Float32Array(batch.numRows);
      const seed = this.dataset._ix_seed;
      this.dataset._ix_seed += batch.numRows;
      for (let i = 0; i < batch.numRows; i++) {
        array[i] = i + seed;
      }
      this._min_ix = seed;
      this._max_ix = seed + batch.numRows;
      // This bubbles up to parents.
      this.highest_known_ix = this._max_ix;
      this._batch = add_or_delete_column(this.record_batch, 'ix', array);
    }
    this._extent = {
      x: extent(this._batch.getChild('x')),
      y: extent(this._batch.getChild('y')),
    };
    this.parent = parent;

    const row_last = this._batch.get(this._batch.numRows - 1);
    if (row_last === null) {
      throw 'No rows in table';
    }
    this.max_ix = Number(row_last.ix);
    this.highest_known_ix = Number(this.max_ix);
    const row_1 = this._batch.get(0);
    if (row_1 === null) {
      throw 'No rows in table';
    }
    this._min_ix = Number(row_1.ix);
    this.highest_known_ix = Number(this.max_ix);
    this.create_children();
  }
  create_children() {
    let ix = this.batch_num * 4;
    while (++ix <= this.batch_num * 4 + 4) {
      if (ix < this.full_tab.batches.length) {
        this._children.push(
          new ArrowTile(this.full_tab, this.dataset, ix, this)
        );
      }
    }
    for (const child of this._children) {
      for (const dim of ['x', 'y'] as const) {
        this._extent[dim][0] = Math.min(
          this._extent[dim][0],
          child._extent[dim][0]
        );
        this._extent[dim][1] = Math.max(
          this._extent[dim][1],
          child._extent[dim][1]
        );
      }
    }
  }

  download(): Promise<RecordBatch> {
    return Promise.resolve(this._batch);
  }

  get ready(): boolean {
    // Arrow tables are always ready.
    return true;
  }
}

type Point = [number, number];

export function p_in_rect(p: Point, rect: Rectangle | undefined) {
  if (rect === undefined) {
    return true;
  }
  const c = rect;
  return (
    p[0] < rect.x[1] && p[0] > rect.x[0] && p[1] < rect.y[1] && p[1] > rect.y[0]
  );
}
function macrotile(key: string, size = 2, parents = 2) {
  let [z, x, y] = key.split("/").map((d) => parseInt(d));
  let moves = 0;
  while (!(moves >= parents && z % size == 0)) {
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
    z = z - 1;
    moves++;
  }
  return `${z}/${x}/${y}`;
}

function macrotile_siblings(key: string, size = 2, parents = 2) : Array<string> {
  return macrotile_descendants(macrotile(key, size, parents), size, parents);
}

const descendant_cache = new Map<string, string[]>();
function macrotile_descendants(macrokey: string, size = 2, parents = 2) : Array<string> {
  if (descendant_cache.has(macrokey)) {
    return descendant_cache.get(macrokey) as string[];
  }
  const parent_tiles = [[macrokey]];
  while (parent_tiles.length < parents) {
    parent_tiles.unshift(parent_tiles[0].map(children).flat());
  }
  const sibling_tiles = [parent_tiles[0].map(children).flat()];
  while (sibling_tiles.length < size) {
    sibling_tiles.unshift(sibling_tiles[0].map(children).flat());
  }
  sibling_tiles.reverse();
  const descendants = sibling_tiles.flat();
  descendant_cache.set(macrokey, descendants);
  return descendants;
}

function children(tile : string) {
  const [z, x, y] = tile.split("/").map((d) => parseInt(d)) as [number, number, number];
  const children = [];
  for (let i = 0; i < 4; i++) {
    children.push(`${z + 1}/${x * 2 + (i % 2)}/${y * 2 + Math.floor(i / 2)}`);
  }
  return children;
}