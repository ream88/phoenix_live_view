import {
  BEFORE_UNLOAD_LOADER_TIMEOUT,
  CHECKABLE_INPUTS,
  CONSECUTIVE_RELOADS,
  PHX_AUTO_RECOVER,
  PHX_COMPONENT,
  PHX_CONNECTED_CLASS,
  PHX_DISABLE_WITH,
  PHX_DISABLE_WITH_RESTORE,
  PHX_DISABLED,
  PHX_DISCONNECTED_CLASS,
  PHX_EVENT_CLASSES,
  PHX_ERROR_CLASS,
  PHX_FEEDBACK_FOR,
  PHX_HAS_SUBMITTED,
  PHX_HOOK,
  PHX_PAGE_LOADING,
  PHX_PARENT_ID,
  PHX_PROGRESS,
  PHX_READONLY,
  PHX_REF,
  PHX_ROOT_ID,
  PHX_SESSION,
  PHX_STATIC,
  PHX_TRACK_STATIC,
  PHX_UPDATE,
  PHX_UPLOAD_REF,
  PHX_VIEW,
  PHX_VIEW_SELECTOR,
  PUSH_TIMEOUT,
} from "phoenix_live_view/constants"

import {
  clone,
  closestPhxBinding,
  isEmpty,
  isEqualObj,
  logError,
  maybe
} from "phoenix_live_view/utils"

import Browser from "phoenix_live_view/browser"
import DOM from "phoenix_live_view/dom"
import DOMPatch from "phoenix_live_view/dom_patch"
import LiveUploader from "phoenix_live_view/live_uploader"
import Rendered from "phoenix_live_view/rendered"
import ViewHook from "phoenix_live_view/view_hook"

let serializeForm = (form, meta = {}) => {
  let formData = new FormData(form)
  let toRemove = []

  formData.forEach((val, key, _index) => {
    if(val instanceof File){ toRemove.push(key) }
  })

  // Cleanup after building fileData
  toRemove.forEach(key => formData.delete(key))

  let params = new URLSearchParams()
  for(let [key, val] of formData.entries()){ params.append(key, val) }
  for(let metaKey in meta){ params.append(metaKey, meta[metaKey]) }

  return params.toString()
}

export default class View {
  constructor(el, liveSocket, parentView, href, flash){
    this.liveSocket = liveSocket
    this.flash = flash
    this.parent = parentView
    this.root = parentView ? parentView.root : this
    this.el = el
    this.id = this.el.id
    this.view = this.el.getAttribute(PHX_VIEW)
    this.ref = 0
    this.childJoins = 0
    this.loaderTimer = null
    this.pendingDiffs = []
    this.pruningCIDs = []
    this.href = href
    this.joinCount = this.parent ? this.parent.joinCount - 1 : 0
    this.joinPending = true
    this.destroyed = false
    this.joinCallback = function (){ }
    this.stopCallback = function (){ }
    this.pendingJoinOps = this.parent ? null : []
    this.viewHooks = {}
    this.uploaders = {}
    this.formSubmits = []
    this.children = this.parent ? null : {}
    this.root.children[this.id] = {}
    this.channel = this.liveSocket.channel(`lv:${this.id}`, () => {
      return {
        url: this.href,
        params: this.connectParams(),
        session: this.getSession(),
        static: this.getStatic(),
        flash: this.flash
      }
    })
    this.showLoader(this.liveSocket.loaderTimeout)
    this.bindChannel()
  }

  isMain(){ return this.liveSocket.main === this }

  connectParams(){
    let params = this.liveSocket.params(this.view)
    let manifest =
      DOM.all(document, `[${this.binding(PHX_TRACK_STATIC)}]`)
        .map(node => node.src || node.href).filter(url => typeof (url) === "string")

    if(manifest.length > 0){ params["_track_static"] = manifest }
    params["_mounts"] = this.joinCount

    return params
  }

  name(){ return this.view }

  isConnected(){ return this.channel.canPush() }

  getSession(){ return this.el.getAttribute(PHX_SESSION) }

  getStatic(){
    let val = this.el.getAttribute(PHX_STATIC)
    return val === "" ? null : val
  }

  destroy(callback = function (){ }){
    this.destroyAllChildren()
    this.destroyed = true
    delete this.root.children[this.id]
    if(this.parent){ delete this.root.children[this.parent.id][this.id] }
    clearTimeout(this.loaderTimer)
    let onFinished = () => {
      callback()
      for(let id in this.viewHooks){
        this.destroyHook(this.viewHooks[id])
      }
    }

    DOM.markPhxChildDestroyed(this.el)

    this.log("destroyed", () => ["the child has been removed from the parent"])
    this.channel.leave()
      .receive("ok", onFinished)
      .receive("error", onFinished)
      .receive("timeout", onFinished)
  }

  setContainerClasses(...classes){
    this.el.classList.remove(
      PHX_CONNECTED_CLASS,
      PHX_DISCONNECTED_CLASS,
      PHX_ERROR_CLASS
    )
    this.el.classList.add(...classes)
  }

  isLoading(){ return this.el.classList.contains(PHX_DISCONNECTED_CLASS) }

  showLoader(timeout){
    clearTimeout(this.loaderTimer)
    if(timeout){
      this.loaderTimer = setTimeout(() => this.showLoader(), timeout)
    } else {
      for(let id in this.viewHooks){ this.viewHooks[id].__disconnected() }
      this.setContainerClasses(PHX_DISCONNECTED_CLASS)
    }
  }

  hideLoader(){
    clearTimeout(this.loaderTimer)
    this.setContainerClasses(PHX_CONNECTED_CLASS)
  }

  triggerReconnected(){
    for(let id in this.viewHooks){ this.viewHooks[id].__reconnected() }
  }

  log(kind, msgCallback){
    this.liveSocket.log(this, kind, msgCallback)
  }

  withinTargets(phxTarget, callback){
    if(phxTarget instanceof HTMLElement){
      return this.liveSocket.owner(phxTarget, view => callback(view, phxTarget))
    }

    if(/^(0|[1-9]\d*)$/.test(phxTarget)){
      let targets = DOM.findComponentNodeList(this.el, phxTarget)
      if(targets.length === 0){
        logError(`no component found matching phx-target of ${phxTarget}`)
      } else {
        callback(this, targets[0])
      }
    } else {
      let targets = Array.from(document.querySelectorAll(phxTarget))
      if(targets.length === 0){ logError(`nothing found matching the phx-target selector "${phxTarget}"`) }
      targets.forEach(target => this.liveSocket.owner(target, view => callback(view, target)))
    }
  }

  applyDiff(type, rawDiff, callback){
    this.log(type, () => ["", clone(rawDiff)])
    let {diff, reply, events, title} = Rendered.extract(rawDiff)
    if(title){ DOM.putTitle(title) }

    callback({diff, reply, events})
    return reply
  }

  onJoin(resp){
    let {rendered} = resp
    this.childJoins = 0
    this.joinPending = true
    this.flash = null

    Browser.dropLocal(this.liveSocket.localStorage, this.name(), CONSECUTIVE_RELOADS)
    this.applyDiff("mount", rendered, ({diff, events}) => {
      this.rendered = new Rendered(this.id, diff)
      let html = this.renderContainer(null, "join")
      this.dropPendingRefs()
      let forms = this.formsForRecovery(html)
      this.joinCount++

      if(forms.length > 0){
        forms.forEach((form, i) => {
          this.pushFormRecovery(form, resp => {
            if(i === forms.length - 1){
              this.onJoinComplete(resp, html, events)
            }
          })
        })
      } else {
        this.onJoinComplete(resp, html, events)
      }
    })
  }

  dropPendingRefs(){ DOM.all(this.el, `[${PHX_REF}]`, el => el.removeAttribute(PHX_REF)) }

  onJoinComplete({live_patch}, html, events){
    // In order to provide a better experience, we want to join
    // all LiveViews first and only then apply their patches.
    if(this.joinCount > 1 || (this.parent && !this.parent.isJoinPending())){
      return this.applyJoinPatch(live_patch, html, events)
    }

    // One downside of this approach is that we need to find phxChildren
    // in the html fragment, instead of directly on the DOM. The fragment
    // also does not include PHX_STATIC, so we need to copy it over from
    // the DOM.
    let newChildren = DOM.findPhxChildrenInFragment(html, this.id).filter(toEl => {
      let fromEl = toEl.id && this.el.querySelector(`#${toEl.id}`)
      let phxStatic = fromEl && fromEl.getAttribute(PHX_STATIC)
      if(phxStatic){ toEl.setAttribute(PHX_STATIC, phxStatic) }
      return this.joinChild(toEl)
    })

    if(newChildren.length === 0){
      if(this.parent){
        this.root.pendingJoinOps.push([this, () => this.applyJoinPatch(live_patch, html, events)])
        this.parent.ackJoin(this)
      } else {
        this.onAllChildJoinsComplete()
        this.applyJoinPatch(live_patch, html, events)
      }
    } else {
      this.root.pendingJoinOps.push([this, () => this.applyJoinPatch(live_patch, html, events)])
    }
  }

  attachTrueDocEl(){
    this.el = DOM.byId(this.id)
    this.el.setAttribute(PHX_ROOT_ID, this.root.id)
  }

  dispatchEvents(events){
    events.forEach(([event, payload]) => {
      window.dispatchEvent(new CustomEvent(`phx:hook:${event}`, {detail: payload}))
    })
  }

  applyJoinPatch(live_patch, html, events){
    this.attachTrueDocEl()
    let patch = new DOMPatch(this, this.el, this.id, html, null)
    patch.markPrunableContentForRemoval()
    this.performPatch(patch, false)
    this.joinNewChildren()
    DOM.all(this.el, `[${this.binding(PHX_HOOK)}], [data-phx-${PHX_HOOK}]`, hookEl => {
      let hook = this.addHook(hookEl)
      if(hook){ hook.__mounted() }
    })

    this.joinPending = false
    this.dispatchEvents(events)
    this.applyPendingUpdates()

    if(live_patch){
      let {kind, to} = live_patch
      this.liveSocket.historyPatch(to, kind)
    }
    this.hideLoader()
    if(this.joinCount > 1){ this.triggerReconnected() }
    this.stopCallback()
  }

  triggerBeforeUpdateHook(fromEl, toEl){
    this.liveSocket.triggerDOM("onBeforeElUpdated", [fromEl, toEl])
    let hook = this.getHook(fromEl)
    let isIgnored = hook && DOM.isIgnored(fromEl, this.binding(PHX_UPDATE))
    if(hook && !fromEl.isEqualNode(toEl) && !(isIgnored && isEqualObj(fromEl.dataset, toEl.dataset))){
      hook.__beforeUpdate()
      return hook
    }
  }

  performPatch(patch, pruneCids){
    let destroyedCIDs = []
    let phxChildrenAdded = false
    let updatedHookIds = new Set()

    patch.after("added", el => {
      this.liveSocket.triggerDOM("onNodeAdded", [el])

      let newHook = this.addHook(el)
      if(newHook){ newHook.__mounted() }
    })

    patch.after("phxChildAdded", _el => phxChildrenAdded = true)

    patch.before("updated", (fromEl, toEl) => {
      let hook = this.triggerBeforeUpdateHook(fromEl, toEl)
      if(hook){ updatedHookIds.add(fromEl.id) }
    })

    patch.after("updated", el => {
      if(updatedHookIds.has(el.id)){ this.getHook(el).__updated() }
    })

    patch.after("discarded", (el) => {
      let cid = this.componentID(el)
      if(typeof (cid) === "number" && destroyedCIDs.indexOf(cid) === -1){ destroyedCIDs.push(cid) }
      let hook = this.getHook(el)
      hook && this.destroyHook(hook)
    })

    patch.perform()

    // We should not pruneCids on joins. Otherwise, in case of
    // rejoins, we may notify cids that no longer belong to the
    // current LiveView to be removed.
    if(pruneCids){
      this.maybePushComponentsDestroyed(destroyedCIDs)
    }

    return phxChildrenAdded
  }

  joinNewChildren(){
    DOM.findPhxChildren(this.el, this.id).forEach(el => this.joinChild(el))
  }

  getChildById(id){ return this.root.children[this.id][id] }

  getDescendentByEl(el){
    if(el.id === this.id){
      return this
    } else {
      return this.children[el.getAttribute(PHX_PARENT_ID)][el.id]
    }
  }

  destroyDescendent(id){
    for(let parentId in this.root.children){
      for(let childId in this.root.children[parentId]){
        if(childId === id){ return this.root.children[parentId][childId].destroy() }
      }
    }
  }

  joinChild(el){
    let child = this.getChildById(el.id)
    if(!child){
      let view = new View(el, this.liveSocket, this)
      this.root.children[this.id][view.id] = view
      view.join()
      this.childJoins++
      return true
    }
  }

  isJoinPending(){ return this.joinPending }

  ackJoin(_child){
    this.childJoins--

    if(this.childJoins === 0){
      if(this.parent){
        this.parent.ackJoin(this)
      } else {
        this.onAllChildJoinsComplete()
      }
    }
  }

  onAllChildJoinsComplete(){
    this.joinCallback()
    this.pendingJoinOps.forEach(([view, op]) => {
      if(!view.isDestroyed()){ op() }
    })
    this.pendingJoinOps = []
  }

  update(diff, events){
    if(this.isJoinPending() || this.liveSocket.hasPendingLink()){
      return this.pendingDiffs.push({diff, events})
    }

    this.rendered.mergeDiff(diff)
    let phxChildrenAdded = false

    // When the diff only contains component diffs, then walk components
    // and patch only the parent component containers found in the diff.
    // Otherwise, patch entire LV container.
    if(this.rendered.isComponentOnlyDiff(diff)){
      this.liveSocket.time("component patch complete", () => {
        let parentCids = DOM.findParentCIDs(this.el, this.rendered.componentCIDs(diff))
        parentCids.forEach(parentCID => {
          if(this.componentPatch(this.rendered.getComponent(diff, parentCID), parentCID)){ phxChildrenAdded = true }
        })
      })
    } else if(!isEmpty(diff)){
      this.liveSocket.time("full patch complete", () => {
        let html = this.renderContainer(diff, "update")
        let patch = new DOMPatch(this, this.el, this.id, html, null)
        phxChildrenAdded = this.performPatch(patch, true)
      })
    }

    this.dispatchEvents(events)
    if(phxChildrenAdded){ this.joinNewChildren() }
  }

  renderContainer(diff, kind){
    return this.liveSocket.time(`toString diff (${kind})`, () => {
      let tag = this.el.tagName
      // Don't skip any component in the diff nor any marked as pruned
      // (as they may have been added back)
      let cids = diff ? this.rendered.componentCIDs(diff).concat(this.pruningCIDs) : null
      let html = this.rendered.toString(cids)
      return `<${tag}>${html}</${tag}>`
    })
  }

  componentPatch(diff, cid){
    if(isEmpty(diff)) return false
    let html = this.rendered.componentToString(cid)
    let patch = new DOMPatch(this, this.el, this.id, html, cid)
    let childrenAdded = this.performPatch(patch, true)
    return childrenAdded
  }

  getHook(el){ return this.viewHooks[ViewHook.elementID(el)] }

  addHook(el){
    if(ViewHook.elementID(el) || !el.getAttribute){ return }
    let hookName = el.getAttribute(`data-phx-${PHX_HOOK}`) || el.getAttribute(this.binding(PHX_HOOK))
    if(hookName && !this.ownsElement(el)){ return }
    let callbacks = this.liveSocket.getHookCallbacks(hookName)

    if(callbacks){
      if(!el.id){ logError(`no DOM ID for hook "${hookName}". Hooks require a unique ID on each element.`, el) }
      let hook = new ViewHook(this, el, callbacks)
      this.viewHooks[ViewHook.elementID(hook.el)] = hook
      return hook
    } else if(hookName !== null){
      logError(`unknown hook found for "${hookName}"`, el)
    }
  }

  destroyHook(hook){
    hook.__destroyed()
    hook.__cleanup__()
    delete this.viewHooks[ViewHook.elementID(hook.el)]
  }

  applyPendingUpdates(){
    this.pendingDiffs.forEach(({diff, events}) => this.update(diff, events))
    this.pendingDiffs = []
  }

  onChannel(event, cb){
    this.liveSocket.onChannel(this.channel, event, resp => {
      if(this.isJoinPending()){
        this.root.pendingJoinOps.push([this, () => cb(resp)])
      } else {
        cb(resp)
      }
    })
  }

  bindChannel(){
    // The diff event should be handled by the regular update operations.
    // All other operations are queued to be applied only after join.
    this.liveSocket.onChannel(this.channel, "diff", (rawDiff) => {
      this.applyDiff("update", rawDiff, ({diff, events}) => this.update(diff, events))
    })
    this.onChannel("redirect", ({to, flash}) => this.onRedirect({to, flash}))
    this.onChannel("live_patch", (redir) => this.onLivePatch(redir))
    this.onChannel("live_redirect", (redir) => this.onLiveRedirect(redir))
    this.channel.onError(reason => this.onError(reason))
    this.channel.onClose(reason => this.onClose(reason))
  }

  destroyAllChildren(){
    for(let id in this.root.children[this.id]){
      this.getChildById(id).destroy()
    }
  }

  onLiveRedirect(redir){
    let {to, kind, flash} = redir
    let url = this.expandURL(to)
    this.liveSocket.historyRedirect(url, kind, flash)
  }

  onLivePatch(redir){
    let {to, kind} = redir
    this.href = this.expandURL(to)
    this.liveSocket.historyPatch(to, kind)
  }

  expandURL(to){
    return to.startsWith("/") ? `${window.location.protocol}//${window.location.host}${to}` : to
  }

  onRedirect({to, flash}){ this.liveSocket.redirect(to, flash) }

  isDestroyed(){ return this.destroyed }

  join(callback){
    if(!this.parent){
      this.stopCallback = this.liveSocket.withPageLoading({to: this.href, kind: "initial"})
    }
    this.joinCallback = () => callback && callback(this, this.joinCount)
    this.liveSocket.wrapPush(this, {timeout: false}, () => {
      return this.channel.join()
        .receive("ok", data => this.onJoin(data))
        .receive("error", resp => this.onJoinError(resp))
        .receive("timeout", () => this.onJoinError({reason: "timeout"}))
    })
  }

  onJoinError(resp){
    if(resp.redirect || resp.live_redirect){
      this.joinPending = false
      this.channel.leave()
    }
    if(resp.redirect){ return this.onRedirect(resp.redirect) }
    if(resp.live_redirect){ return this.onLiveRedirect(resp.live_redirect) }
    this.log("error", () => ["unable to join", resp])
    return this.liveSocket.reloadWithJitter(this)
  }

  onClose(reason){
    if(this.isDestroyed()){ return }
    if((this.isJoinPending() && document.visibilityState !== "hidden") ||
      (this.liveSocket.hasPendingLink() && reason !== "leave")){

      return this.liveSocket.reloadWithJitter(this)
    }
    this.destroyAllChildren()
    this.liveSocket.dropActiveElement(this)
    // document.activeElement can be null in Internet Explorer 11
    if(document.activeElement){ document.activeElement.blur() }
    if(this.liveSocket.isUnloaded()){
      this.showLoader(BEFORE_UNLOAD_LOADER_TIMEOUT)
    }
  }

  onError(reason){
    this.onClose(reason)
    this.log("error", () => ["view crashed", reason])
    if(!this.liveSocket.isUnloaded()){ this.displayError() }
  }

  displayError(){
    if(this.isMain()){ DOM.dispatchEvent(window, "phx:page-loading-start", {to: this.href, kind: "error"}) }
    this.showLoader()
    this.setContainerClasses(PHX_DISCONNECTED_CLASS, PHX_ERROR_CLASS)
  }

  pushWithReply(refGenerator, event, payload, onReply = function (){ }){
    if(!this.isConnected()){ return }

    let [ref, [el]] = refGenerator ? refGenerator() : [null, []]
    let onLoadingDone = function (){ }
    if(el && (el.getAttribute(this.binding(PHX_PAGE_LOADING)) !== null)){
      onLoadingDone = this.liveSocket.withPageLoading({kind: "element", target: el})
    }

    if(typeof (payload.cid) !== "number"){ delete payload.cid }
    return (
      this.liveSocket.wrapPush(this, {timeout: true}, () => {
        return this.channel.push(event, payload, PUSH_TIMEOUT).receive("ok", resp => {
          let hookReply = null
          if(ref !== null){ this.undoRefs(ref) }
          if(resp.diff){
            hookReply = this.applyDiff("update", resp.diff, ({diff, events}) => {
              this.update(diff, events)
            })
          }
          if(resp.redirect){ this.onRedirect(resp.redirect) }
          if(resp.live_patch){ this.onLivePatch(resp.live_patch) }
          if(resp.live_redirect){ this.onLiveRedirect(resp.live_redirect) }
          onLoadingDone()
          onReply(resp, hookReply)
        })
      })
    )
  }

  undoRefs(ref){
    DOM.all(this.el, `[${PHX_REF}="${ref}"]`, el => {
      // remove refs
      el.removeAttribute(PHX_REF)
      // restore inputs
      if(el.getAttribute(PHX_READONLY) !== null){
        el.readOnly = false
        el.removeAttribute(PHX_READONLY)
      }
      if(el.getAttribute(PHX_DISABLED) !== null){
        el.disabled = false
        el.removeAttribute(PHX_DISABLED)
      }
      // remove classes
      PHX_EVENT_CLASSES.forEach(className => DOM.removeClass(el, className))
      // restore disables
      let disableRestore = el.getAttribute(PHX_DISABLE_WITH_RESTORE)
      if(disableRestore !== null){
        el.innerText = disableRestore
        el.removeAttribute(PHX_DISABLE_WITH_RESTORE)
      }
      let toEl = DOM.private(el, PHX_REF)
      if(toEl){
        let hook = this.triggerBeforeUpdateHook(el, toEl)
        DOMPatch.patchEl(el, toEl, this.liveSocket.getActiveElement())
        if(hook){ hook.__updated() }
        DOM.deletePrivate(el, PHX_REF)
      }
    })
  }

  putRef(elements, event){
    let newRef = this.ref++
    let disableWith = this.binding(PHX_DISABLE_WITH)

    elements.forEach(el => {
      el.classList.add(`phx-${event}-loading`)
      el.setAttribute(PHX_REF, newRef)
      let disableText = el.getAttribute(disableWith)
      if(disableText !== null){
        if(!el.getAttribute(PHX_DISABLE_WITH_RESTORE)){
          el.setAttribute(PHX_DISABLE_WITH_RESTORE, el.innerText)
        }
        el.innerText = disableText
      }
    })
    return [newRef, elements]
  }

  componentID(el){
    let cid = el.getAttribute && el.getAttribute(PHX_COMPONENT)
    return cid ? parseInt(cid) : null
  }

  targetComponentID(target, targetCtx){
    if(target.getAttribute(this.binding("target"))){
      return this.closestComponentID(targetCtx)
    } else {
      return null
    }
  }

  closestComponentID(targetCtx){
    if(targetCtx){
      return maybe(targetCtx.closest(`[${PHX_COMPONENT}]`), el => this.ownsElement(el) && this.componentID(el))
    } else {
      return null
    }
  }

  pushHookEvent(targetCtx, event, payload, onReply){
    if(!this.isConnected()){
      this.log("hook", () => ["unable to push hook event. LiveView not connected", event, payload])
      return false
    }
    let [ref, els] = this.putRef([], "hook")
    this.pushWithReply(() => [ref, els], "event", {
      type: "hook",
      event: event,
      value: payload,
      cid: this.closestComponentID(targetCtx)
    }, (resp, reply) => onReply(reply, ref))

    return ref
  }

  extractMeta(el, meta){
    let prefix = this.binding("value-")
    for(let i = 0; i < el.attributes.length; i++){
      let name = el.attributes[i].name
      if(name.startsWith(prefix)){ meta[name.replace(prefix, "")] = el.getAttribute(name) }
    }
    if(el.value !== undefined){
      meta.value = el.value

      if(el.tagName === "INPUT" && CHECKABLE_INPUTS.indexOf(el.type) >= 0 && !el.checked){
        delete meta.value
      }
    }
    return meta
  }

  pushEvent(type, el, targetCtx, phxEvent, meta){
    this.pushWithReply(() => this.putRef([el], type), "event", {
      type: type,
      event: phxEvent,
      value: this.extractMeta(el, meta),
      cid: this.targetComponentID(el, targetCtx)
    })
  }

  pushKey(keyElement, targetCtx, kind, phxEvent, meta){
    this.pushWithReply(() => this.putRef([keyElement], kind), "event", {
      type: kind,
      event: phxEvent,
      value: this.extractMeta(keyElement, meta),
      cid: this.targetComponentID(keyElement, targetCtx)
    })
  }

  pushFileProgress(fileEl, entryRef, progress, onReply = function (){ }){
    this.liveSocket.withinOwners(fileEl.form, (view, targetCtx) => {
      view.pushWithReply(null, "progress", {
        event: fileEl.getAttribute(view.binding(PHX_PROGRESS)),
        ref: fileEl.getAttribute(PHX_UPLOAD_REF),
        entry_ref: entryRef,
        progress: progress,
        cid: view.targetComponentID(fileEl.form, targetCtx)
      }, onReply)
    })
  }

  pushInput(inputEl, targetCtx, phxEvent, eventTarget, callback){
    let uploads
    let cid = this.targetComponentID(inputEl.form, targetCtx)
    let refGenerator = () => this.putRef([inputEl, inputEl.form], "change")
    let formData = serializeForm(inputEl.form, {_target: eventTarget.name})
    if(inputEl.files && inputEl.files.length > 0){
      LiveUploader.trackFiles(inputEl, Array.from(inputEl.files))
    }
    uploads = LiveUploader.serializeUploads(inputEl)
    let event = {
      type: "form",
      event: phxEvent,
      value: formData,
      uploads: uploads,
      cid: cid
    }
    this.pushWithReply(refGenerator, "event", event, resp => {
      DOM.showError(inputEl, this.liveSocket.binding(PHX_FEEDBACK_FOR))
      if(DOM.isUploadInput(inputEl) && inputEl.getAttribute("data-phx-auto-upload") !== null){
        if(LiveUploader.filesAwaitingPreflight(inputEl).length > 0){
          let [ref, _els] = refGenerator()
          this.uploadFiles(inputEl.form, targetCtx, ref, cid, (_uploads) => {
            callback && callback(resp)
            this.triggerAwaitingSubmit(inputEl.form)
          })
        }
      } else {
        callback && callback(resp)
      }
    })
  }

  triggerAwaitingSubmit(formEl){
    let awaitingSubmit = this.getScheduledSubmit(formEl)
    if(awaitingSubmit){
      let [_el, _ref, callback] = awaitingSubmit
      this.cancelSubmit(formEl)
      callback()
    }
  }

  getScheduledSubmit(formEl){
    return this.formSubmits.find(([el, _callback]) => el.isSameNode(formEl))
  }

  scheduleSubmit(formEl, ref, callback){
    if(this.getScheduledSubmit(formEl)){ return true }
    this.formSubmits.push([formEl, ref, callback])
  }

  cancelSubmit(formEl){
    this.formSubmits = this.formSubmits.filter(([el, ref, _callback]) => {
      if(el.isSameNode(formEl)){
        this.undoRefs(ref)
        return false
      } else {
        return true
      }
    })
  }

  pushFormSubmit(formEl, targetCtx, phxEvent, onReply){
    let filterIgnored = el => {
      let userIgnored = closestPhxBinding(el, `${this.binding(PHX_UPDATE)}=ignore`, el.form)
      return !(userIgnored || closestPhxBinding(el, "data-phx-update=ignore", el.form))
    }
    let filterDisables = el => {
      return el.hasAttribute(this.binding(PHX_DISABLE_WITH))
    }
    let filterButton = el => el.tagName == "BUTTON"

    let filterInput = el => ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)

    let refGenerator = () => {
      let formElements = Array.from(formEl.elements)
      let disables = formElements.filter(filterDisables)
      let buttons = formElements.filter(filterButton).filter(filterIgnored)
      let inputs = formElements.filter(filterInput).filter(filterIgnored)

      buttons.forEach(button => {
        button.setAttribute(PHX_DISABLED, button.disabled)
        button.disabled = true
      })
      inputs.forEach(input => {
        input.setAttribute(PHX_READONLY, input.readOnly)
        input.readOnly = true
        if(input.files){
          input.setAttribute(PHX_DISABLED, input.disabled)
          input.disabled = true
        }
      })
      formEl.setAttribute(this.binding(PHX_PAGE_LOADING), "")
      return this.putRef([formEl].concat(disables).concat(buttons).concat(inputs), "submit")
    }

    let cid = this.targetComponentID(formEl, targetCtx)
    if(LiveUploader.hasUploadsInProgress(formEl)){
      let [ref, _els] = refGenerator()
      return this.scheduleSubmit(formEl, ref, () => this.pushFormSubmit(formEl, targetCtx, phxEvent, onReply))
    } else if(LiveUploader.inputsAwaitingPreflight(formEl).length > 0){
      let [ref, els] = refGenerator()
      let proxyRefGen = () => [ref, els]
      this.uploadFiles(formEl, targetCtx, ref, cid, (_uploads) => {
        let formData = serializeForm(formEl, {})
        this.pushWithReply(proxyRefGen, "event", {
          type: "form",
          event: phxEvent,
          value: formData,
          cid: cid
        }, onReply)
      })
    } else {
      let formData = serializeForm(formEl)
      this.pushWithReply(refGenerator, "event", {
        type: "form",
        event: phxEvent,
        value: formData,
        cid: cid
      }, onReply)
    }
  }

  uploadFiles(formEl, targetCtx, ref, cid, onComplete){
    let joinCountAtUpload = this.joinCount
    let inputEls = LiveUploader.activeFileInputs(formEl)

    // get each file input
    inputEls.forEach(inputEl => {
      let uploader = new LiveUploader(inputEl, this, onComplete)
      this.uploaders[inputEl] = uploader
      let entries = uploader.entries().map(entry => entry.toPreflightPayload())

      let payload = {
        ref: inputEl.getAttribute(PHX_UPLOAD_REF),
        entries: entries,
        cid: this.targetComponentID(inputEl.form, targetCtx)
      }

      this.log("upload", () => ["sending preflight request", payload])

      this.pushWithReply(null, "allow_upload", payload, resp => {
        this.log("upload", () => ["got preflight response", resp])
        if(resp.error){
          this.undoRefs(ref)
          let [entry_ref, reason] = resp.error
          this.log("upload", () => [`error for entry ${entry_ref}`, reason])
        } else {
          let onError = (callback) => {
            this.channel.onError(() => {
              if(this.joinCount === joinCountAtUpload){ callback() }
            })
          }
          uploader.initAdapterUpload(resp, onError, this.liveSocket)
        }
      })
    })
  }

  pushFormRecovery(form, callback){
    this.liveSocket.withinOwners(form, (view, targetCtx) => {
      let input = form.elements[0]
      let phxEvent = form.getAttribute(this.binding(PHX_AUTO_RECOVER)) || form.getAttribute(this.binding("change"))
      view.pushInput(input, targetCtx, phxEvent, input, callback)
    })
  }

  pushLinkPatch(href, targetEl, callback){
    let linkRef = this.liveSocket.setPendingLink(href)
    let refGen = targetEl ? () => this.putRef([targetEl], "click") : null

    this.pushWithReply(refGen, "link", {url: href}, resp => {
      if(resp.link_redirect){
        this.liveSocket.replaceMain(href, null, callback, linkRef)
      } else {
        if(this.liveSocket.commitPendingLink(linkRef)){
          this.href = href
        }
        this.applyPendingUpdates()
        callback && callback(linkRef)
      }
    }).receive("timeout", () => this.liveSocket.redirect(window.location.href))
  }

  formsForRecovery(html){
    if(this.joinCount === 0){ return [] }

    let phxChange = this.binding("change")
    let template = document.createElement("template")
    template.innerHTML = html

    return (
      DOM.all(this.el, `form[${phxChange}]`)
        .filter(form => this.ownsElement(form))
        .filter(form => form.elements.length > 0)
        .filter(form => form.getAttribute(this.binding(PHX_AUTO_RECOVER)) !== "ignore")
        .filter(form => template.content.querySelector(`form[${phxChange}="${form.getAttribute(phxChange)}"]`))
    )
  }

  maybePushComponentsDestroyed(destroyedCIDs){
    let willDestroyCIDs = destroyedCIDs.filter(cid => {
      return DOM.findComponentNodeList(this.el, cid).length === 0
    })
    if(willDestroyCIDs.length > 0){
      this.pruningCIDs.push(...willDestroyCIDs)

      this.pushWithReply(null, "cids_will_destroy", {cids: willDestroyCIDs}, () => {
        // The cids are either back on the page or they will be fully removed,
        // so we can remove them from the pruningCIDs.
        this.pruningCIDs = this.pruningCIDs.filter(cid => willDestroyCIDs.indexOf(cid) !== -1)

        // See if any of the cids we wanted to destroy were added back,
        // if they were added back, we don't actually destroy them.
        let completelyDestroyCIDs = willDestroyCIDs.filter(cid => {
          return DOM.findComponentNodeList(this.el, cid).length === 0
        })

        if(completelyDestroyCIDs.length > 0){
          this.pushWithReply(null, "cids_destroyed", {cids: completelyDestroyCIDs}, (resp) => {
            this.rendered.pruneCIDs(resp.cids)
          })
        }
      })
    }
  }

  ownsElement(el){
    return el.getAttribute(PHX_PARENT_ID) === this.id ||
      maybe(el.closest(PHX_VIEW_SELECTOR), node => node.id) === this.id
  }

  submitForm(form, targetCtx, phxEvent){
    DOM.putPrivate(form, PHX_HAS_SUBMITTED, true)
    this.liveSocket.blurActiveElement(this)
    this.pushFormSubmit(form, targetCtx, phxEvent, () => {
      this.liveSocket.restorePreviouslyActiveFocus()
    })
  }

  binding(kind){ return this.liveSocket.binding(kind) }
}