/* Exact Codex navigation; read receipts stay bound to the clicked result version. */
(function(scope){
  class TaskNavigation {
    constructor({api,getCard,isConnected,onPending=()=>{},onOpened=()=>{},onRead=()=>{},onError=()=>{},readPlay}){
      Object.assign(this,{api,getCard,isConnected,onPending,onOpened,onRead,onError,readPlay});
      this.revision=0;this.pending=null;this.queue=Promise.resolve();
    }
    navigate(id){
      if(this.pending?.id===id)return this.pending.promise;
      if(!this.isConnected()){this.onError('连接恢复后再打开，未读结果会保留');return Promise.resolve(false);}
      const revision=++this.revision;
      const clicked=this.getCard(id);
      const version=clicked?.unread&&clicked.status!=='running'?clicked.pending_result_version:null;
      this.onPending(id);
      // Serialize OS dispatches and skip superseded queued clicks so the final target wins.
      const promise=this.queue.then(async()=>{
        if(revision!==this.revision)return false;
        const current=this.getCard(id);
        if(version&&current?.pending_result_version===version)this.readPlay?.arm(current);
        const opened=await this.api('/api/threads/'+encodeURIComponent(id)+'/open',{});
        if(opened?.ok!==true)throw Error('Codex 尚未确认打开，请重试');
        if(revision!==this.revision){this.readPlay?.cancel(id);return false;}
        this.onOpened(id);
        const matches=card=>card?.unread&&card.status!=='running'&&card.pending_result_version===version;
        if(!version||!matches(this.getCard(id))){this.readPlay?.cancel(id);return true;}
        try{
          const receipt=await this.api('/api/threads/'+encodeURIComponent(id)+'/ack',{version});
          if(receipt?.ok!==true)throw Error('未收到保存回执');
          this.readPlay?.setWeeklyHarvest?.(receipt.weekly_harvest);
          const card=this.getCard(id);
          if(matches(card)){
            card.unread=false;card.pending_result_version=null;
            this.readPlay?.confirm({threadId:id,version},card);
            this.onRead(id);
          }else this.readPlay?.cancel(id);
        }catch(error){
          this.readPlay?.cancel(id);
          this.onError('已打开 Codex，已读标记未保存：'+error.message);
        }
        return true;
      }).catch(error=>{
        this.readPlay?.cancel(id);
        if(revision===this.revision)this.onError('任务未打开：'+error.message);
        return false;
      }).finally(()=>{
        if(revision===this.revision){this.pending=null;this.onPending(null);}
      });
      this.pending={id,promise};this.queue=promise;
      return promise;
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=TaskNavigation;
  scope.WorkTwinTaskNavigation=TaskNavigation;
})(typeof window!=='undefined'?window:globalThis);
