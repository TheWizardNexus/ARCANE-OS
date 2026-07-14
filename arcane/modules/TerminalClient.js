import TerminalSession from '../entities/TerminalSession.js';

export default class TerminalClient extends EventTarget{
    constructor(api=globalThis.Arcane?.terminal){
        super();
        this.api=api||null;
        this.sessions=new Map();
        this.unsubscribe=[];
        const events=globalThis.Arcane?.events;
        if(events?.on){
            for(const type of ['terminal.output','terminal.exit','terminal.error']){
                this.unsubscribe.push(events.on(type,data=>this.receive(type,data)));
            }
        }
    }

    get available(){ return Boolean(this.api?.start&&this.api?.write&&this.api?.close); }

    async start(options={}){
        if(!this.available) throw new Error('The Arcane native terminal capability is unavailable. Open Terminal from the installed Arcane shell.');
        const result=await this.api.start(options);
        const session=new TerminalSession({...result,state:'running'});
        this.sessions.set(session.id,session);
        this.emit('session',{session});
        return session;
    }

    async write(id,data){ TerminalSession.id(id);return this.api.write(id,String(data??'')); }
    async resize(id,columns,rows){ TerminalSession.id(id);return this.api.resize(id,Number(columns),Number(rows)); }
    async signal(id,signal='interrupt'){ TerminalSession.id(id);return this.api.signal(id,String(signal)); }
    async close(id){
        TerminalSession.id(id);
        const result=await this.api.close(id);
        const session=this.sessions.get(id);
        if(session) this.sessions.set(id,session.with({state:'closed'}));
        return result;
    }

    receive(type,data={}){
        const id=String(data.sessionId||'');
        if(!id||!this.sessions.has(id)) return;
        if(type==='terminal.exit'){
            const session=this.sessions.get(id).with({state:'exited'});
            this.sessions.set(id,session);
            this.emit('exit',{...data,session});
        }else if(type==='terminal.error') this.emit('error',data);
        else this.emit('output',data);
    }

    emit(type,detail){ this.dispatchEvent(new CustomEvent(`terminal-${type}`,{detail})); }
    destroy(){ for(const off of this.unsubscribe) if(typeof off==='function') off();this.unsubscribe=[]; }
}
