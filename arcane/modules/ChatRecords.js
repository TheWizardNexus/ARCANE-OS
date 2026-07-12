function hasUserEntry(chat=[]){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];

    return messages.some(
        message=>message?.role==='user'
    );
}

export {
    hasUserEntry
};
