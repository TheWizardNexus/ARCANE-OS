import Calculation from '../entities/Calculation.js';

const FUNCTIONS=Object.freeze({sqrt:Math.sqrt,abs:Math.abs,sin:Math.sin,cos:Math.cos,tan:Math.tan,log:Math.log10,ln:Math.log});
const CONSTANTS=Object.freeze({pi:Math.PI,e:Math.E});

function tokenize(input){const source=String(input??'').trim();if(!source||source.length>512)throw new TypeError('Expression must contain 1-512 characters.');const tokens=[];let index=0;while(index<source.length){const rest=source.slice(index);const whitespace=rest.match(/^\s+/);if(whitespace){index+=whitespace[0].length;continue}const numeric=rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);if(numeric){tokens.push({type:'number',value:Number(numeric[0])});index+=numeric[0].length;continue}const identifier=rest.match(/^[a-z]+/i);if(identifier){tokens.push({type:'name',value:identifier[0].toLowerCase()});index+=identifier[0].length;continue}const symbol=source[index];if('+-*/%^()'.includes(symbol)){tokens.push({type:symbol,value:symbol});index++;continue}throw new SyntaxError(`Unexpected character at position ${index+1}.`)}tokens.push({type:'end'});return tokens;}

export function evaluateExpression(input){const tokens=tokenize(input);let cursor=0;const peek=()=>tokens[cursor];const take=type=>{if(peek().type!==type)throw new SyntaxError(`Expected ${type}.`);return tokens[cursor++]};
    function primary(){const token=peek();if(token.type==='number'){cursor++;return token.value}if(token.type==='name'){cursor++;if(Object.hasOwn(CONSTANTS,token.value))return CONSTANTS[token.value];const fn=FUNCTIONS[token.value];if(!fn)throw new SyntaxError(`Unknown function: ${token.value}.`);take('(');const value=expression();take(')');return fn(value)}if(token.type==='('){cursor++;const value=expression();take(')');return value}throw new SyntaxError('Expected a number, constant, function, or parenthesized expression.')}
    function unary(){if(peek().type==='+'){cursor++;return unary()}if(peek().type==='-'){cursor++;return -unary()}return primary()}
    function power(){let value=unary();if(peek().type==='^'){cursor++;value=Math.pow(value,power())}return value}
    function product(){let value=power();while(['*','/','%'].includes(peek().type)){const operator=tokens[cursor++].type,right=power();if((operator==='/'||operator==='%')&&right===0)throw new RangeError('Division by zero is undefined.');value=operator==='*'?value*right:operator==='/'?value/right:value%right}return value}
    function expression(){let value=product();while(['+','-'].includes(peek().type)){const operator=tokens[cursor++].type,right=product();value=operator==='+'?value+right:value-right}return value}
    const result=expression();if(peek().type!=='end')throw new SyntaxError('Unexpected content after the expression.');if(!Number.isFinite(result))throw new RangeError('The calculation did not produce a finite result.');return result;
}

export default class CalculatorEngine extends EventTarget{
    calculate(expression){try{const calculation=new Calculation({expression,result:evaluateExpression(expression)});this.dispatchEvent(event('calculator-result',calculation));return calculation}catch(error){this.dispatchEvent(event('calculator-error',{expression:String(expression??''),error}));throw error}}
}
function event(type,detail){return new CustomEvent(type,{detail});}
