const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHELLS=new Set(['auto','powershell','cmd','bash','sh']);
const STATES=new Set(['starting','running','exited','closed','error']);

export default class TerminalSession{
    constructor({id,shell='auto',cwd='',title='',state='starting',createdAt=new Date().toISOString()}={}){
        this.id=TerminalSession.id(id);
        this.shell=TerminalSession.shell(shell);
        this.cwd=String(cwd||'');
        this.title=String(title||this.shellLabel());
        this.state=TerminalSession.state(state);
        this.createdAt=String(createdAt||new Date().toISOString());
    }

    shellLabel(){
        return {auto:'Terminal',powershell:'PowerShell',cmd:'Command Prompt',bash:'Bash',sh:'Shell'}[this.shell];
    }

    with(patch={}){
        return new TerminalSession({...this.toJSON(),...patch,id:this.id});
    }

    toJSON(){
        return {id:this.id,shell:this.shell,cwd:this.cwd,title:this.title,state:this.state,createdAt:this.createdAt};
    }

    static id(value){
        const id=String(value||'').trim();
        if(!ID_PATTERN.test(id)) throw new TypeError('Terminal session IDs must be stable, nonempty identifiers.');
        return id;
    }

    static shell(value){
        const shell=String(value||'auto').trim().toLowerCase();
        if(!SHELLS.has(shell)) throw new TypeError(`Unsupported terminal shell: ${shell}`);
        return shell;
    }

    static state(value){
        const state=String(value||'starting').trim().toLowerCase();
        if(!STATES.has(state)) throw new TypeError(`Unsupported terminal session state: ${state}`);
        return state;
    }
}

export const terminalShells=Object.freeze([...SHELLS]);
