import Is from '../node_modules/strong-type/index.js';
import '../modules/DBOPFS.js';

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
 * @typedef {Object} StreamOfConsciousnessRecord
 * @property {string} date
 * @property {string} title
 * @property {string} entry
 * @property {string} user
 */

class StreamOfConsciousness {

	#fileName = '';
	#date = '';
	#title = '';
	#entry = '';
	#user = '';

	constructor(fileName = '') {
		if (!is.string(fileName)) {
			throw new TypeError('StreamOfConsciousness constructor expects fileName to be a string');
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
	 * Returns stream data in the required schema.
	 *
	 * @returns {StreamOfConsciousnessRecord}
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
	 * Loads a stream record by file name.
	 *
	 * @param {string} fileName
	 * @returns {Promise<StreamOfConsciousness>}
	 */
	async load(fileName = '') {
		if (fileName) {
			this.#fileName = fileName;
		}

		if (!this.#fileName) {
			throw new Error('StreamOfConsciousness.load requires a fileName');
		}

		const record = await dbopfs.get('streams_of_consciousness', this.#fileName);

		if (!record || typeof record !== 'object') {
			throw new Error(`Stream of consciousness record not found for fileName: ${this.#fileName}`);
		}

		this.date = record.date || '';
		this.title = record.title || '';
		this.entry = record.entry || '';
		this.user = record.user || '';

		return this;
	}

	/**
	 * Saves a stream record into the OPFS streams of consciousness table.
	 *
	 * @param {Object} streamData
	 * @param {string} [streamData.date]
	 * @param {string} [streamData.title]
	 * @param {string} [streamData.entry]
	 * @param {string} [streamData.user]
	 * @returns {Promise<StreamOfConsciousness>}
	 */
	async save(streamData = {}) {
		if (!streamData || typeof streamData !== 'object') {
			throw new Error('StreamOfConsciousness.save expects an object with date, title, entry, and user');
		}

		const {
			date = `${Date.now()}`,
			title = '',
			entry = '',
			user = ''
		} = streamData;

		this.date = date;
		this.title = title;
		this.entry = entry;
		this.user = user;

		if (!this.#fileName) {
			this.#fileName = `stream-${Date.now()}-${generateUUID()}.json`;
		}

		await dbopfs.set('streams_of_consciousness', this.#fileName, this.meta);

		return this;
	}

}

export default StreamOfConsciousness;
