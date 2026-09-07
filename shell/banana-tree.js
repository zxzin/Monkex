/* Ripe fruit reflects unread results; small green fruit reflects live work. */
(function(scope){
  const taskCount=value=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
  function harvestState(unread,connected){
    const count=taskCount(unread);
    return {count,visible:Math.min(5,count),connected:connected===true};
  }
  function growthState(running,connected){
    const count=connected===true?taskCount(running):0;
    return {count,visible:Math.min(3,count),connected:connected===true};
  }
  function renderFruit(root,view){
    if(!root)return view;
    root.dataset.connected=String(view.connected);root.dataset.count=String(view.count);
    [...root.children].forEach((fruit,index)=>{fruit.hidden=index>=view.visible;});
    return view;
  }
  function render(root,unread,connected){return renderFruit(root,harvestState(unread,connected));}
  function renderGrowth(root,running,connected){return renderFruit(root,growthState(running,connected));}
  function activityState(unread,running,connected){
    const count=harvestState(unread,connected).count;
    const active=growthState(running,connected).count;
    const state=connected!==true?'offline':count?'completed':active?'running':'idle';
    const label=connected!==true?'果园状态待同步':[
      count?count+' 根香蕉待收':'',active?active+' 项任务进行中':''
    ].filter(Boolean).join(' · ')||'暂无待收香蕉';
    return {state,running:active>0,runningCount:active,label};
  }
  const api={harvestState,growthState,render,renderGrowth,activityState};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.WorkTwinBananaTree=api;
})(typeof window==='undefined'?globalThis:window);
