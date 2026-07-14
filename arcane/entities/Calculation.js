export default class Calculation{
    constructor({expression,result,createdAt=new Date()}={}){
        this.expression=String(expression??'').trim();
        if(!this.expression||this.expression.length>512) throw new TypeError('Calculation expressions must contain 1-512 characters.');
        this.result=Number(result);
        if(!Number.isFinite(this.result)) throw new RangeError('Calculation result must be finite.');
        const instant=new Date(createdAt);
        if(Number.isNaN(instant.valueOf())) throw new TypeError('Calculation time is invalid.');
        this.createdAt=instant.toISOString();
        Object.freeze(this);
    }
    toJSON(){return {...this};}
}
