import Is from '../../../node_modules/strong-type/index.js';
import '../../../arcane/modules/DBOPFS.js';
import '../../../arcane/modules/DBLS.js';

const is = new Is(false);

function generateUUID() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
		(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
	);
}

function parseStoredRecord(record) {
	if (!is.string(record)) {
		return record;
	}

	try {
		return JSON.parse(record);
	} catch(err) {
		return record;
	}
}

function getLegacyTimestamp(dateString = '') {
	let timestamp = new Date(dateString).getTime();

	if (Number.isFinite(timestamp)) {
		return timestamp;
	}

	const parts = `${dateString}`.match(
		/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})$/
	);

	if (!parts) {
		return NaN;
	}

	timestamp = new Date(
		Number(parts[1]),
		Number(parts[2])-1,
		Number(parts[3]),
		Number(parts[4]),
		Number(parts[5])
	).getTime();

	return timestamp;
}

/**
 * @typedef {Object} NotesRecord
 * @property {string} id
 * @property {'assessment note'|'topics of discussion'|'treatment options'} type
 * @property {string} note
 * @property {string} timestamps
 * @property {string|number} username
 */

class Notes {

	#id = '';
	#type = '';
	#fileName = '';
	#note = '';
	#timestamps = '';
	#username = '';

	constructor(id = '') {
		if (!is.string(id)) {
			throw new TypeError('Notes constructor expects id to be a string');
		}

		if (id) {
			this.#id = id;
		}

		return this;
	}

	/**
	 * Loads normalized OPFS notes and includes legacy records from this
	 * application's scoped local-storage namespace when they are not already
	 * represented in OPFS.
	 *
	 * @returns {Promise<NotesRecord[]>}
	 */
	static async getAll() {
		const items = await dbopfs.getAll('notes');
		const storedRecords = Object.values(items);
		const records = [];
		const legacyUsername = parseStoredRecord(window.dbls.get('username'));
		const defaultUsername = window.user?.username || legacyUsername || '';

		for (let i = 0; i < storedRecords.length; i++) {
			const record = parseStoredRecord(storedRecords[i]);

			if (!record || typeof record !== 'object' || Array.isArray(record)) {
				continue;
			}

			if (!record.username) {
				record.username = defaultUsername;
			}

			records.push(record);
		}

		const noteTypes = {
			mental_health_assessment: 'assessment note',
			topics_of_discussion_or_activities: 'topics of discussion',
			treatment_options: 'treatment options'
		};
		const keys = window.dbls.getAllKeys();

		for (let i = 0; i < keys.length; i++) {
			const storageKey = keys[i];
			const typeSeparator = storageKey.lastIndexOf('$');

			if (typeSeparator < 1) {
				continue;
			}

			let dateString = storageKey.slice(0,typeSeparator);
			const legacyType = storageKey.slice(typeSeparator+1);
			const type = noteTypes[legacyType];
			let username = defaultUsername;

			if (!type) {
				continue;
			}

			const usernameSeparator = dateString.indexOf('$$');

			if (usernameSeparator > -1) {
				username = dateString.slice(0,usernameSeparator);
				dateString = dateString.slice(usernameSeparator+2);
			}

			const timestamps = getLegacyTimestamp(dateString);
			const note = parseStoredRecord(window.dbls.get(storageKey));

			if (!Number.isFinite(timestamps) || !is.string(note) || !note) {
				continue;
			}

			const alreadyStored = records.some(
				function matchingNote(record) {
					return record
						&& `${record.username || ''}` === `${username}`
						&& record.type === type
						&& record.note === note
						&& Math.abs(Number(record.timestamps)-timestamps) < 60000;
				}
			);

			if (alreadyStored) {
				continue;
			}

			records.push({
				id: `legacy-note-${encodeURIComponent(`${username}` || 'local')}-${timestamps}-${legacyType}`,
				type: type,
				note: note,
				timestamps: `${timestamps}`,
				username: username
			});
		}

		return records;
	}

	/**
	 * Saves the standard three notes emitted by text_assessment.
	 *
	 * @param {Object} params
	 * @param {string|number} username
	 * @returns {Promise<boolean>}
	 */
	static async saveFromTextAssessment(params = {}, username = '') {
		if (!params || typeof params !== 'object') {
			return false;
		}

		const timestamps = Date.now();

		const rows = [
			{
				type: 'assessment note',
				note: params.mental_health_assessment || ''
			},
			{
				type: 'topics of discussion',
				note: params.topics_of_discussion_or_activities || ''
			},
			{
				type: 'treatment options',
				note: params.treatment_options || ''
			}
		];

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];

			if (!is.string(row.note) || !row.note) {
				continue;
			}

			const note = new Notes();
			await note.save({
				type: row.type,
				note: row.note,
				timestamps: timestamps,
				username: username
			});
		}

		return true;
	}

	get id() {
		return this.#id;
	}

	set id(value = '') {
		if (!is.string(value) || !value) {
			throw new TypeError('id setter expects a non-empty string');
		}

		this.#id = value;
	}

	get type() {
		return this.#type;
	}

	set type(value = '') {
		if (!is.string(value)) {
			throw new TypeError('type setter expects a string');
		}

		this.#type = value;
	}

	get fileName() {
		return this.#fileName;
	}

	get note() {
		return this.#note;
	}

	set note(value = '') {
		if (!is.string(value)) {
			throw new TypeError('note setter expects a string');
		}

		this.#note = value;
	}

	get timestamps() {
		return this.#timestamps;
	}

	set timestamps(value = '') {
		if (`${value}`.length < 1) {
			throw new TypeError('timestamps setter expects a non-empty string');
		}

		this.#timestamps = `${value}`;
	}

	get username() {
		return this.#username;
	}

	set username(value = '') {
		if (!is.union(value,'string','number')) {
			throw new TypeError('username setter expects a string or number');
		}

		this.#username = value;
	}

	/**
	 * Returns Notes record in the requested schema.
	 *
	 * @returns {NotesRecord}
	 */
	get meta() {
		return {
			id: this.id,
			type: this.type,
			note: this.#note,
			timestamps: this.#timestamps,
			username: this.#username
		};
	}

	/**
	 * Loads a Notes record by file name from OPFS.
	 *
	 * @param {string} fileName
	 * @returns {Promise<Notes>}
	 */
	async load(fileName = '') {
		if (fileName) {
			this.#fileName = fileName;
		}

		if (!this.#fileName) {
			throw new Error('Notes.load requires a fileName');
		}

		let record = parseStoredRecord(
			await dbopfs.get('notes', this.#fileName)
		);

		if (!record || typeof record !== 'object') {
			throw new Error(`Notes record not found for fileName: ${this.#fileName}`);
		}

		this.id = record.id || this.#id;
		this.type = record.type;
		this.note = record.note || '';
		this.timestamps = record.timestamps || '';
		this.username = record.username || '';

		return this;
	}

	/**
	 * Saves a Notes record into OPFS.
	 *
	 * @param {Object} noteData
	 * @param {string} noteData.type
	 * @param {string} noteData.note
	 * @param {string|number} [noteData.timestamps]
	 * @param {string|number} [noteData.username]
	 * @returns {Promise<Notes>}
	 */
	async save(noteData = {}) {
		if (!noteData || typeof noteData !== 'object') {
			throw new Error('Notes.save expects an object with type, note, and timestamps');
		}

		const {
			type = '',
			note = '',
			timestamps = Date.now(),
			username = ''
		} = noteData;

		this.type = type;
		this.note = note;
		this.timestamps = timestamps;
		this.username = username;

		if (!this.id) {
			this.id = generateUUID();
		}

		this.#fileName = `notes-${this.id}-${this.type}`;

		await dbopfs.set('notes', this.#fileName, this.meta);

		return this;
	}

}

export default Notes;
