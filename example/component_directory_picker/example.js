const picker=document.querySelector('#directoryPicker');
const output=document.querySelector('#eventOutput');

picker.addEventListener('directory-picker-ready',()=>{
    picker.configure({
        label:'Local repository folder',
        help:'Choose an existing local checkout. Nothing is uploaded or scanned by this control.',
        title:'Choose a local repository folder'
    });
},{once:true});

picker.addEventListener('directory-picker-change',event=>{
    output.textContent=`Selected: ${event.detail.path}`;
});

picker.addEventListener('directory-picker-cancel',event=>{
    output.textContent=event.detail.path
        ?`Selection canceled. Keeping: ${event.detail.path}`
        :'Selection canceled. No folder is selected.';
});

picker.addEventListener('directory-picker-error',event=>{
    output.textContent=`Selector unavailable: ${event.detail.message}`;
});
