import Is from '../node_modules/strong-type/index.js';
import '../modules/DBOPFS.js';
import MD from '../modules/MD.js';

const is = new Is(false);

class FileEntity {

    #tableName = '';

    #fileName = '';

    persist = true;

    constructor(fileName = '', tableName = '') {
        if (!is.string(tableName) || !tableName) {
            tableName = this.#tableName;
        }
        if (!is.string(fileName) || !fileName) {
            fileName = this.#fileName;
        }

        this.#tableName = tableName;
        this.#fileName = fileName;

        return this;
    }

    get tableName() {
        return this.#tableName;
    }

    set tableName(value) {
        return this.#tableName=value;
    }

    get fileName() {
        return this.#fileName;
    }

    set fileName(fileName = '') {
        if (!is.string(fileName) || !fileName) {
            return this.#fileName;
        }

        this.#fileName = fileName;
        return this.#fileName;
    }

    async open() {
        const file = await dbopfs.readFile(
            this.#tableName,
            this.#fileName
        );

        const mimeTypes ={
            "json": "application/json",
            "jsonl": "application/x-ndjson",
            "ndjson": "application/x-ndjson",

            "txt": "text/plain;charset=utf-8",
            "log": "text/plain;charset=utf-8",
            "md": "text/markdown;charset=utf-8",

            "html": "text/html;charset=utf-8",
            "css": "text/css;charset=utf-8",
            "js": "text/javascript;charset=utf-8",
            "mjs": "text/javascript;charset=utf-8",

            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "svg": "image/svg+xml",

            "pdf": "application/pdf"
        };

        file.ext=this.fileName.slice(
            (this.fileName.lastIndexOf('.')+1)
        ).toLowerCase();

        const mime=mimeTypes[file.ext]||
            file.type||
            'application/octet-stream';

        file.mime=mime;
        file.parsed=null;

        switch(file.ext){
            case 'json':
                file.parsed=await file.text();

                try{
                    file.parsed=JSON.parse(file.parsed.trim());
                }catch(e){}
                break;
            case 'jsonl':
            case 'ndjson':
                const rows=(await file.text()).split('\n');
                const parsedRows=[];

                for(let i=0;i<rows.length;i++){
                    try{
                        parsedRows.push(
                            JSON.parse(rows[i].trim())
                        );
                    }catch(e){}
                }

                file.parsed=parsedRows;
                break;
            case 'md':
                file.parsed=new MD(await file.text()).rendered;
                break;
            case 'txt':
            case 'log':
            case 'html':
            case 'css':
            case 'js':
            case 'mjs':
                file.parsed=await file.text();
                break;
        }

        return file;
    }

    async save(fileData) {
        // fileData can be a File, Blob, ArrayBuffer, TypedArray like Uint8Array,
        // DataView, or string. Other values such as numbers, booleans, arrays,
        // or plain objects should be converted first with String(), JSON.stringify(),
        // or wrapped in a Blob before writing.
        return dbopfs.writeFile(
            this.#tableName,
            this.#fileName,
            fileData
        );
    }

}

export default FileEntity;
