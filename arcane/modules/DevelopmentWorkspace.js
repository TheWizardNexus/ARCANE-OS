const ROOT_MAX_LENGTH=4096;
const QUERY_MAX_LENGTH=4096;
const TASK_ID_PATTERN=/^[a-z][a-z0-9-]{0,63}$/;

function workspaceRoot(value){
    const root=String(value??'').trim();
    if(!root||root.length>ROOT_MAX_LENGTH||/[\u0000-\u001f]/.test(root)){
        throw new TypeError('Choose one existing development workspace directory.');
    }
    return root;
}

function contextQuery(value){
    const query=String(value??'').trim();
    if(query.length>QUERY_MAX_LENGTH||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)){
        throw new TypeError('Development context queries must be bounded plain text.');
    }
    return query;
}

function setupTaskId(value){
    const taskId=String(value??'').trim().toLowerCase();
    if(!TASK_ID_PATTERN.test(taskId)){
        throw new TypeError('Choose a registered development setup task.');
    }
    return taskId;
}

/**
 * Provider-neutral client for a native development-workspace capability.
 *
 * The provider owns filesystem authorization, canonical-path validation,
 * context filtering, the setup-task allowlist, and an optional fixed Node.js
 * prerequisite installer. This module never accepts an arbitrary command and
 * never discovers workspaces on the user's machine.
 */
export default class DevelopmentWorkspace{
    constructor(api=globalThis.Arcane?.development){
        this.api=api||null;
    }

    get available(){
        return Boolean(this.api?.inspect&&this.api?.context&&this.api?.setup);
    }

    get nodeInstallerAvailable(){
        return Boolean(this.api?.installNode);
    }

    require(method){
        if(!this.available||typeof this.api?.[method]!=='function'){
            throw new Error('The Arcane development-workspace capability is unavailable. Open this application through an installed Arcane OS developer build.');
        }
        return this.api[method].bind(this.api);
    }

    inspect(root){
        return this.require('inspect')(workspaceRoot(root));
    }

    context(root,query=''){
        return this.require('context')(workspaceRoot(root),contextQuery(query));
    }

    setup(root,taskId){
        return this.require('setup')(workspaceRoot(root),setupTaskId(taskId));
    }

    installNode(){
        return this.require('installNode')();
    }
}

export {contextQuery,setupTaskId,workspaceRoot};
