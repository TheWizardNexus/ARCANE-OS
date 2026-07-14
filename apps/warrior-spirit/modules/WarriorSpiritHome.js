import {programs} from './WarriorSpiritPrograms.js';
import {bindPageActions} from './WarriorSpiritPage.js';

bindPageActions();
renderPrograms();

function renderPrograms(){
    const grid=document.querySelector('#programGrid');
    const fragment=document.createDocumentFragment();
    for(const program of programs){
        const article=document.createElement('article');
        const number=document.createElement('span');
        const title=document.createElement('h3');
        const audience=document.createElement('strong');
        const description=document.createElement('p');
        article.className='program-card program-card--static';
        article.setAttribute('role','listitem');
        number.className='program-number';number.textContent=program.number;
        title.textContent=program.name;
        audience.textContent=program.audience;
        description.textContent=program.description;
        article.append(number,title,audience,description);
        fragment.append(article);
    }
    grid.replaceChildren(fragment);
}
