import {ID, Index} from "./API";
import {ROOT, ROOT_PARENT} from "./Constants";
import {BackendChange, Change, changeSortCompare, ensureBackendChange, toID} from "./Change";
import {
	BackendAssignment,
	BackendInsertion,
	BackendListAssignment,
	Deletion,
	isBackendAssignment,
	isBackendInsertion,
	isBackendListAssignment,
	isDeletion
} from "./Action";
import {BackendPrimitive, ObjectKind} from "./Primitive";
import {Entry, MetaMap, MetaObject} from "./StateObject";
import {assignToList, findIndexInTombstoneArray, findInsertionIndex, insertInList} from "./ArrayUtils";
import {render} from "./Renderer";
import {ensureNumber} from "./Util";

export default class State<T = any> {
	private objects: MetaMap;
	private _seen: Set<ID>;
	private clock: number;

	constructor(private readonly changes: BackendChange[]) {
		this.clock = changes[changes.length - 1]?.clock ?? 0;
		this._seen = new Set<ID>();
		this.witness(this.changes);
		this.reapplyAllChanges();
	}

	private seen(change: Change | ID): boolean {
		const id: ID = typeof change === "string" ? change : toID(change);
		return this._seen.has(id);
	}

	private witness(changes: Change[]): void {
		changes.map(toID)
			.forEach((id: ID) => this._seen.add(id));
	}

	public next(): number {
		return this.clock + 1;
	}

	public latest(): ID | undefined {
		if (this.changes.length > 0) {
			return toID(this.changes[this.changes.length - 1]);
		} else {
			return undefined;
		}
	}

	public getElement(indices: Index[]): ID {
		return this.getElementImpl([ROOT, ...indices]);
	}

	public getParentElement(indices: Index[]): ID {
		const element = this.getElementImpl([ROOT, ...indices].slice(0, -1));
		this.getMetaObject(element); // for side effect of asserting that this is indexable
		return element;
	}

	private getElementImpl(indices: Index[]): ID {
		return indices.reduce((name: ID, index: Index): ID => {
			const metaObject = this.getMetaObject(name);
			let entry: Entry;
			if (metaObject instanceof Map) {
				entry = metaObject.get(index);
			} else {
				entry = metaObject[findIndexInTombstoneArray(metaObject, ensureNumber(index))];
			}
			return entry?.deleted ? undefined :
				entry?.kind === ObjectKind.OTHER ? entry?.name : (entry?.value as ID);
		}, ROOT_PARENT) as ID;
	}

	public addChange(changes: Change[]): BackendChange[] {
		const backendChanges = changes
			.filter((change) => !this.seen(change))
			.map(ensureBackendChange)
			.sort(changeSortCompare);
		this.witness(backendChanges);
		if (backendChanges.length > 0 && backendChanges[0].clock > this.clock) {
			this.appendChanges(backendChanges);
			this.applyChanges(backendChanges);
		} else if (backendChanges.length > 0) {
			this.insertChanges(backendChanges);
			this.reapplyAllChanges();
		}
		return backendChanges;
	}

	private appendChanges(changes: BackendChange[]): void {
		this.clock = changes[changes.length - 1].clock;
		this.changes.push(...changes);
	}

	private insertChanges(changes: BackendChange[]): void {
		this.changes.push(...changes);
		this.changes.sort(changeSortCompare);
	}

	private reapplyAllChanges(): void {
		const root = {name: undefined, kind: ObjectKind.OTHER, value: undefined, deleted: true};
		const rootParent = new Map<Index, Entry>().set(ROOT, root);
		this.objects = new Map<ID, Map<Index, Entry>>().set(ROOT_PARENT, rootParent);
		this.applyChanges(this.changes);
	}

	private applyChanges(changes: BackendChange[]): void {
		changes
			.filter((change: BackendChange) => !change.dep || this.seen(change.dep))
			.forEach((change: BackendChange) => this.applyChange(change));
	}

	private applyChange(change: BackendChange): void {
		const {action} = change;
		if (isBackendAssignment(action)) {
			this.applyAssignment(action);
		} else if (isBackendListAssignment(action)) {
			this.applyListAssignment(action);
		} else if (isBackendInsertion(action)) {
			this.applyInsertion(action);
		} else if (isDeletion(action)) {
			this.applyDeletion(action);
		}
	}

	private getMetaObject(name: ID): MetaObject {
		const currentMap = this.objects.get(name);
		if (!currentMap) {
			throw new RangeError("Indexable element does not exist at this index");
		}
		return currentMap;
	}

	private createMetaObject(item: BackendPrimitive): void {
		const {name, kind} = item;
		if (kind === ObjectKind.OBJECT) {
			this.objects.set(name, new Map());
		} else if (kind === ObjectKind.ARRAY) {
			this.objects.set(name, []);
		}
	}

	private applyAssignment(assignment: BackendAssignment): void {
		const {item, at, in: _in} = assignment;
		const {name, value, kind} = item;
		const parent = this.getMetaObject(_in);
		if (Array.isArray(parent)) {
			throw new EvalError("Key assignment into a list should never happen");
		} else {
			parent.set(at, {name, value, kind, deleted: false});
		}
		this.createMetaObject(item);
	}

	private applyListAssignment(assignment: BackendListAssignment): void {
		const {item, at, in: _in} = assignment;
		const parent = this.getMetaObject(_in);
		if (Array.isArray(parent)) {
			assignToList(parent, at, item);
		} else {
			throw new EvalError("Index assignment into an object should never happen");
		}
		this.createMetaObject(item);
	}

	private applyInsertion(insertion: BackendInsertion): void {
		const {item, in: _in} = insertion;
		const parent = this.getMetaObject(_in);
		if (Array.isArray(parent)) {
			const index = findInsertionIndex(parent, insertion);
			insertInList(parent, index, item);
		} else {
			// TODO should really ensure this happens before application time
			throw new RangeError("Cannot insert into a non-list");
		}
		this.createMetaObject(item);
	}

	private applyDeletion(deletion: Deletion): void {
		const {at, in: _in} = deletion;
		const parent = this.getMetaObject(_in);
		if (Array.isArray(parent)) {
			parent
				.forEach((entry, index) =>
					(entry.name === at) && (parent[index] = {...entry, deleted: true}));
		} else {
			Array.from(parent.entries())
				.forEach(([name, entry]) =>
					(entry.name === at) && parent.set(name, {...entry, deleted: true}));
		}
	}

	public listChanges(): BackendChange[] {
		return this.changes.slice();
	}

	public render(): T {
		return render(this.objects);
	}
}
