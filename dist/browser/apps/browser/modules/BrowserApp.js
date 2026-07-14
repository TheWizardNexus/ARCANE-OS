const navigatorView=document.querySelector('#navigator');
function configure(){navigatorView.configure({homeUrl:'https://example.com/',initialUrl:'https://example.com/'});}
navigatorView.addEventListener('web-navigator-ready',configure,{once:true});navigatorView.addEventListener('web-open-external',event=>globalThis.open(event.detail.url,'_blank','noopener,noreferrer'));if(navigatorView.ready)configure();
