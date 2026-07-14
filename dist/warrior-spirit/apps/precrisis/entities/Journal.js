import Is from '../../../node_modules/strong-type/index.js';
import '../../../arcane/modules/DBOPFS.js';

const is = new Is(false);

function generateUUID() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
		(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
	);
}

/**
 * @typedef {Object} JournalRecord
 * @property {string} date
 * @property {string} title
 * @property {string} entry
 * @property {string} user
 */

class Journal {

	#fileName = '';
	#date = '';
	#title = '';
	#entry = '';
	#user = '';

	constructor(fileName = '') {
		if (!is.string(fileName)) {
			throw new TypeError('Journal constructor expects fileName to be a string');
		}

		if (fileName) {
			this.#fileName = fileName;
		}

		return this;
	}

	get fileName() {
		return this.#fileName;
	}

	get date() {
		return this.#date;
	}

	set date(value = '') {
		if (!is.string(value)) {
			throw new TypeError('date setter expects a string');
		}

		this.#date = value;
	}

	get title() {
		return this.#title;
	}

	set title(value = '') {
		if (!is.string(value)) {
			throw new TypeError('title setter expects a string');
		}

		this.#title = value;
	}

	get entry() {
		return this.#entry;
	}

	set entry(value = '') {
		if (!is.string(value)) {
			throw new TypeError('entry setter expects a string');
		}

		this.#entry = value;
	}

	get user() {
		return this.#user;
	}

	set user(value = '') {
		if (!is.string(value)) {
			throw new TypeError('user setter expects a string');
		}

		this.#user = value;
	}

	/**
	 * Returns journal data in required schema.
	 *
	 * @returns {JournalRecord}
	 */
	get meta() {
		return {
			date: this.#date,
			title: this.#title,
			entry: this.#entry,
			user: this.#user
		};
	}

	/**
	 * Loads a journal record by file name.
	 *
	 * @param {string} fileName
	 * @returns {Promise<Journal>}
	 */
	async load(fileName = '') {
		if (fileName) {
			this.#fileName = fileName;
		}

		if (!this.#fileName) {
			throw new Error('Journal.load requires a fileName');
		}

		const record = await dbopfs.get('journal_entries', this.#fileName);

		if (!record || typeof record !== 'object') {
			throw new Error(`Journal record not found for fileName: ${this.#fileName}`);
		}

		this.date = record.date || '';
		this.title = record.title || '';
		this.entry = record.entry || '';
		this.user = record.user || '';

		return this;
	}

	/**
	 * Saves a journal record into the OPFS journal entries table.
	 *
	 * @param {Object} journalData
	 * @param {string} [journalData.date]
	 * @param {string} [journalData.title]
	 * @param {string} [journalData.entry]
	 * @param {string} [journalData.user]
	 * @returns {Promise<Journal>}
	 */
	async save(journalData = {}) {
		if (!journalData || typeof journalData !== 'object') {
			throw new Error('Journal.save expects an object with date, title, entry, and user');
		}

		const {
			date = `${Date.now()}`,
			title = '',
			entry = '',
			user = ''
		} = journalData;

		this.date = date;
		this.title = title;
		this.entry = entry;
		this.user = user;

		if (!this.#fileName) {
			this.#fileName = `journal-${Date.now()}-${generateUUID()}.json`;
		}

		await dbopfs.set('journal_entries', this.#fileName, this.meta);

		return this;
	}

}

export default Journal;
