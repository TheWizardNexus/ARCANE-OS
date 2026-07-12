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
 * Represents report metadata.
 *
 * @typedef {Object} ReportMeta
 * @property {string} id - Unique report identifier.
 * @property {string} type - Report type (assessment_complete, crisis_detection, etc.).
 * @property {number} generatedAt - Timestamp in milliseconds.
 * @property {string} username - User this report is for.
 * @property {*} data - Report content/payload.
 */

/**
 * Reports
 *
 * Manages report storage and retrieval in the OPFS `reports` directory.
 *
 * Each report is stored as a JSON file with a unique ID.
 * Reports contain assessment results, crisis data, risk evaluations, etc.
 *
 * Example usage:
 *
 * ```js
 * const report = new Reports();
 * await report.save({
 *   type: 'assessment_complete',
 *   username: 'user123',
 *   data: { } // assessment data
 * });
 * ```
 */
class Reports {

	/**
	 * Unique report identifier.
	 *
	 * @type {string}
	 */
	#id = '';

	/**
	 * Report type (assessment_complete, crisis_detection, fitness_for_service, etc.).
	 *
	 * @type {string}
	 */
	#type = '';

	/**
	 * Username associated with this report.
	 *
	 * @type {string}
	 */
	#username = '';

	/**
	 * Timestamp when report was generated.
	 *
	 * @type {number}
	 */
	#generatedAt = 0;

	/**
	 * Report content/payload.
	 *
	 * @type {*}
	 */
	#data = {};

	/**
	 * Creates a new Reports instance.
	 *
	 * @param {string} id Optional existing report ID.
	 */
	constructor(id = '') {
		if (!is.string(id)) {
			throw new TypeError('Reports constructor expects id to be a string');
		}

		if (id) {
			this.#id = id;
		}

		return this;
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

	get username() {
		return this.#username;
	}

	set username(value = '') {
		if (!is.string(value)) {
			throw new TypeError('username setter expects a string');
		}

		this.#username = value;
	}

	get generatedAt() {
		return this.#generatedAt;
	}

	set generatedAt(value = 0) {
		if (!is.number(value) || value < 0) {
			throw new TypeError('generatedAt expects a non-negative timestamp number');
		}

		this.#generatedAt = value;
	}

	get data() {
		return this.#data;
	}

	set data(value = {}) {
		this.#data = value;
	}

	/**
	 * Returns report metadata as a plain object.
	 *
	 * @returns {ReportMeta}
	 */
	get meta() {
		return {
			id: this.#id,
			type: this.#type,
			generatedAt: this.#generatedAt,
			username: this.#username,
			data: this.#data
		};
	}

	/**
	 * Saves a report to OPFS.
	 *
	 * @param {Object} reportData
	 * @param {string} reportData.type Report type.
	 * @param {string} reportData.username Username.
	 * @param {*} reportData.data Report content.
	 * @returns {Promise<Reports>}
	 */
	async save(reportData = {}) {
		if (!reportData || typeof reportData !== 'object') {
			throw new Error('Reports.save expects an object with type, username, and data');
		}

		const { type = '', username = '', data = {} } = reportData;

		if (!is.string(type) || !type) {
			throw new Error('Reports.save requires a type (string)');
		}

		this.#type = type;
		this.#username = username;
		this.#data = data;
		this.#generatedAt = Date.now();

		if (!this.#id) {
			this.#id = `report-${generateUUID()}-${type}`;
		}

		const reportJSON = this.meta;

		await dbopfs.set('reports', this.#id, reportJSON);

		return this;
	}

}

export default Reports;
