const ID=/^[A-Za-z0-9_-]{6,64}$/;
export function parseYouTubeMedia(value){
    const raw=String(value||'').trim();if(!raw)throw new TypeError('Enter a YouTube video or playlist URL.');let url;
    try{url=new URL(raw.includes('://')?raw:`https://${raw}`)}catch{if(ID.test(raw))return Object.freeze({type:'video',id:raw});throw new TypeError('YouTube address is invalid.')}
    const host=url.hostname.replace(/^www\./,'');let video='',playlist=url.searchParams.get('list')||'';
    if(host==='youtu.be')video=url.pathname.split('/').filter(Boolean)[0]||'';
    else if(['youtube.com','music.youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host)){
        if(url.pathname==='/watch')video=url.searchParams.get('v')||'';
        else if(url.pathname.startsWith('/embed/'))video=url.pathname.split('/')[2]||'';
        else if(url.pathname.startsWith('/shorts/'))video=url.pathname.split('/')[2]||'';
    }else throw new TypeError('Only YouTube and YouTube Music addresses are supported.');
    if(video&&ID.test(video))return Object.freeze({type:'video',id:video,playlist:ID.test(playlist)?playlist:''});
    if(ID.test(playlist))return Object.freeze({type:'playlist',id:playlist});
    throw new TypeError('The address does not contain a supported video or playlist id.');
}
export function youtubeEmbedUrl(locator,{privacyEnhanced=true}={}){const item=typeof locator==='string'?parseYouTubeMedia(locator):locator;const origin=privacyEnhanced?'https://www.youtube-nocookie.com':'https://www.youtube.com';if(item.type==='playlist')return `${origin}/embed?listType=playlist&list=${encodeURIComponent(item.id)}`;const url=new URL(`${origin}/embed/${encodeURIComponent(item.id)}`);if(item.playlist)url.searchParams.set('list',item.playlist);url.searchParams.set('playsinline','1');return url.href;}
