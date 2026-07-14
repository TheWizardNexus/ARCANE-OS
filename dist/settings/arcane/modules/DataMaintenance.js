import './DBOPFS.js';
import {hasUserEntry} from './ChatRecords.js';
import {hasMemoryContent} from './MemoryRecords.js';

async function clearEmptyChatsAndMemories(){
    await waitForDBOPFS();

    const chatFileNames=await dbopfs.getAllKeys('chats');
    const emptyChats=[];

    for(let i=0;i<chatFileNames.length;i++){
        const chat=await dbopfs.get(
            'chats',
            chatFileNames[i],
            true
        );

        if(!hasUserEntry(chat)){
            emptyChats.push(chatFileNames[i]);
        }
    }

    const memoryFileNames=await dbopfs.getAllKeys('memories');
    const associatedMemories=new Set(
        emptyChats.map(chatFileName=>`memory-${chatFileName}`)
    );
    const emptyMemories=new Set();

    for(let i=0;i<memoryFileNames.length;i++){
        const memory=await dbopfs.get(
            'memories',
            memoryFileNames[i],
            true
        );

        if(
            associatedMemories.has(memoryFileNames[i])
            || !hasMemoryContent(memory)
        ){
            emptyMemories.add(memoryFileNames[i]);
        }
    }

    const chatResults=await dbopfs.deleteMany('chats',emptyChats);
    const memoryResults=await dbopfs.deleteMany(
        'memories',
        Array.from(emptyMemories)
    );
    const deletedChats=chatResults.filter(
        result=>result.status==='fulfilled'
    ).length;
    const deletedMemories=memoryResults.filter(
        result=>result.status==='fulfilled'
    ).length;

    return {
        checkedChats:chatFileNames.length,
        checkedMemories:memoryFileNames.length,
        deletedChats:deletedChats,
        deletedMemories:deletedMemories,
        failed:(emptyChats.length-deletedChats)
            +(emptyMemories.size-deletedMemories)
    };
}

function waitForDBOPFS(){
    if(window.dbopfs?.ready){
        return Promise.resolve(window.dbopfs);
    }

    return new Promise(
        function waitForDBOPFSPromise(resolve){
            function ready(){
                window.removeEventListener('dbopfs-ready',ready);
                resolve(window.dbopfs);
            }

            window.addEventListener('dbopfs-ready',ready);

            if(window.dbopfs?.ready){
                ready();
            }
        }
    );
}

export {
    clearEmptyChatsAndMemories,
    hasMemoryContent,
    hasUserEntry
};
