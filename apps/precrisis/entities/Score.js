import Is from '../node_modules/strong-type/index.js';
import '../modules/DBOPFS.js';
import Reports from './Reports.js';

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
 * Represents a score record.
 *
 * @typedef {Object} ScoreRecord
 * @property {string} id - Unique score identifier.
 * @property {string} type - Score label or metric type.
 * @property {*} data - Score data or payload.
 * @property {number} date - Date timestamp in milliseconds.
 * @property {string|number} username - User identifier.
 */

/**
 * Score
 *
 * Score-focused entity built on top of Reports.
 */
class Score extends Reports {

	/**
	 * Creates a Score instance.
	 *
	 * @param {string} id Optional existing score id.
	 */
	constructor(id = '') {
		if (!is.string(id)) {
			throw new TypeError('Score constructor expects id to be a string');
		}

		super(id);
		return this;
	}

	get date() {
		return this.generatedAt;
	}

	set date(value = 0) {
		if (!is.number(value) || value < 0) {
			throw new TypeError('date setter expects a non-negative number');
		}

		this.generatedAt = value;
	}

	get data() {
		return super.data;
	}

	set data(v = 0) {
		if (!is.defined(v)) {
			throw new TypeError('data setter expects a defined value');
		}

		super.data = v;
	}

	/**
	 * Returns score metadata as a plain object.
	 *
	 * @returns {ScoreRecord}
	 */
	get meta() {
		return {
			id: this.id,
			type: this.type,
			data: this.data,
			date: this.date,
			username: this.username
		};
	}

	/**
	 * Saves a score to OPFS.
	 *
	 * @param {Object} scoreData
	 * @param {string} scoreData.type Score type/label.
	 * @param {*} [scoreData.data] Score data or payload.
	 * @param {string|number} [scoreData.username] User identifier.
	 * @returns {Promise<Score>}
	 */
	async save(scoreData = {}) {
		if (!scoreData || typeof scoreData !== 'object') {
			throw new Error('Invalid score data');
		}

		const {
			type = '',
			data = 0,
			username = ''
		} = scoreData;

		this.date = Date.now();
		this.type = type;
		this.data = data;
		this.username = username;

		if (!this.id) {
			this.id = `score-${generateUUID()}-${this.type}`;
		}

		await dbopfs.set('scores', this.id, this.meta);

		return this;
	}

}

export default Score;
