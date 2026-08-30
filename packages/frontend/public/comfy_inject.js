;(function () {
  // src/inject/uuid_color.js
  function uuidv4() {
    return ("10000000-1000-4000-8000" + -1e11).replace(
      /[018]/g,
      (a) => (a ^ Math.random() * 16 >> a / 4).toString(16)
    );
  }
  function getRandomColor() {
    return `#${`00000${(Math.random() * 16777216 << 0).toString(16)}`.substr(-6)}`;
  }
  var LINK_TYPE_COLORS = {
    MODEL: "#b4a7d6",
    DIFFUSION_MODEL: "#b4a7d6",
    CLIP: "#ffd166",
    VAE: "#f79f9f",
    CONDITIONING: "#f4a261",
    LATENT: "#f9c7d4",
    IMAGE: "#64b5f6",
    MASK: "#81c784",
    MESH: "#6dd45c",
    NUMBER: "#9e9e9e",
    INT: "#9e9e9e",
    FLOAT: "#9e9e9e",
    STRING: "#d9a441",
    TEXT: "#d9a441",
    BOOLEAN: "#b06fb0",
    COMBO: "#b06fb0",
    AUDIO: "#7fb3d5",
    VIDEO: "#7fb3d5"
  };
  function colorizeLinks() {
    try {
      const g = window.app && window.app.graph;
      if (!g || !g.links) return;
      for (const id of Object.keys(g.links)) {
        const link = g.links[id];
        if (!link) continue;
        const color = LINK_TYPE_COLORS[link.type] || "#9e9e9e";
        if (link.color !== color) link.color = color;
      }
      g.setDirtyCanvas && g.setDirtyCanvas(true, true);
    } catch (e) {
      console.warn("[ArtifyInject] colorizeLinks failed:", e);
    }
  }
  function colorizeCanvas() {
    try {
      const c = window.app && window.app.canvas;
      if (!c) return;
      if (!c.default_connection_color_byType) c.default_connection_color_byType = {};
      if (!c.default_connection_color_byTypeOff) c.default_connection_color_byTypeOff = {};
      const fallback = "#9e9e9e";
      const fill = (table) => {
        for (const key of Object.keys(table)) {
          if (!table[key]) table[key] = LINK_TYPE_COLORS[key] || fallback;
        }
      };
      fill(c.default_connection_color_byType);
      fill(c.default_connection_color_byTypeOff);
      c.setDirtyCanvas && c.setDirtyCanvas(true, true);
    } catch (e) {
      console.warn("[ArtifyInject] colorizeCanvas failed:", e);
    }
  }

  // src/inject/canvas_patches.js
  function serializer(replacer, cycleReplacer) {
    var stack = [], keys = [];
    if (cycleReplacer == null)
      cycleReplacer = function(key, value) {
        if (stack[0] === value) return "[Circular ~]";
        return "[Circular ~." + keys.slice(0, stack.indexOf(value)).join(".") + "]";
      };
    return function(key, value) {
      if (stack.length > 0) {
        var thisPos = stack.indexOf(this);
        ~thisPos ? stack.splice(thisPos + 1) : stack.push(this);
        ~thisPos ? keys.splice(thisPos, Infinity, key) : keys.push(key);
        if (~stack.indexOf(value)) value = cycleReplacer.call(this, key, value);
      } else stack.push(value);
      return replacer == null ? value : replacer.call(this, key, value);
    };
  }
  function stringify(obj, replacer, spaces, cycleReplacer) {
    return JSON.stringify(obj, serializer(replacer, cycleReplacer), spaces);
  }
  function loadCssCode(code, win) {
    const { document: document2 } = win;
    const style = document2.createElement("style");
    style.type = "text/css";
    style.rel = "stylesheet";
    style.appendChild(document2.createTextNode(code));
    const head = document2.getElementsByTagName("head")[0];
    head.appendChild(style);
  }
  function getComfyUIApp() {
    let app = window.app;
    if (!app) {
      const vueAppEl = document.querySelector("#vue-app");
      if (vueAppEl && vueAppEl.__vue_app__) {
        const vueApp = vueAppEl.__vue_app__;
        if (vueApp._instance) {
          app = vueApp._instance.proxy;
        }
      }
    }
    let LiteGraph = window.LiteGraph || window.LGraph;
    if (!LiteGraph) {
      for (const key of Object.keys(window)) {
        if (key === "LiteGraph" || key === "LGraph") {
          LiteGraph = window[key];
          break;
        }
      }
    }
    return { app, LiteGraph };
  }
  function handleComfyuiContext(onReady) {
    const { app, LiteGraph } = getComfyUIApp();
    if (!app || !LiteGraph) {
      setTimeout(() => {
        const { app: retryApp, LiteGraph: retryLiteGraph } = getComfyUIApp();
        if (!retryApp || !retryLiteGraph) {
          console.warn("[ArtifyInject] Could not find ComfyUI app instance after retry");
          onReady();
          return;
        }
        doHandleComfyuiContext(retryApp, retryLiteGraph, onReady);
      }, 1e3);
      return;
    }
    doHandleComfyuiContext(app, LiteGraph, onReady);
  }
  function doHandleComfyuiContext(app, LiteGraph, onReady) {
    const isArtifyMode = artify_inject === "readonly" || isIframe || artify_playground;
    if (isArtifyMode) {
      const ARTIFY_EVENT_TYPES = [
        "updateParamsNodes",
        "centerOnNode",
        "loadGraphData",
        "updatePrompt"
      ];
      const eventBus = {
        callbacks: [],
        send: (message) => {
          window.parent.postMessage(message, "*");
        },
        on: (cb) => {
          eventBus.callbacks.push(cb);
        }
      };
      window.addEventListener("message", (event) => {
        let data = event.data;
        if (typeof data === "string") {
          try {
            data = JSON.parse(data);
          } catch {
            return;
          }
        }
        if (data && data.eventType && ARTIFY_EVENT_TYPES.includes(data.eventType)) {
          for (const i in eventBus.callbacks) {
            eventBus.callbacks[i](data);
          }
        }
      });
      if (artify_inject === "readonly") {
        app.canvas.allow_dragnodes = false;
        app.canvas.allow_reconnect_links = false;
        app.canvas.allow_searchbox = false;
        app.handleFile = () => {
        };
      }
      if (app.ui && app.ui.workflowManager && (artify_inject === "readonly" || isIframe || artify_playground)) {
        try {
          const manager = app.ui.workflowManager;
          if (app.ui.settings) {
            try {
              app.ui.settings.setFieldValue("Comfy.WorkflowManager.TabRestoration", false);
              app.ui.settings.setFieldValue("Comfy.Workflows.TabRestoration", false);
            } catch (e) {
            }
          }
          if (manager.workflows && manager.workflows.length > 1) {
            console.log("[ArtifyInject] Cleaning up extra workflows...");
            const workflowsToClose = [...manager.workflows].slice(1);
            workflowsToClose.forEach((w) => {
              try {
                manager.closeWorkflow(w.id);
              } catch (err) {
              }
            });
          }
        } catch (e) {
          console.warn("[ArtifyInject] Failed to patch workflowManager:", e);
        }
      }
      let paramsNodes = [];
      const origin_drawNodeShape = app.canvas.drawNodeShape;
      app.canvas.drawNodeShape = function(node, ctx, size, fgcolor, bgcolor, selected) {
        const isSelected = paramsNodes.some((item) => item.id === node.id);
        const outputNode = paramsNodes.find(
          (item) => item.id === node.id && item.category === "output"
        );
        fgcolor = outputNode ? outputNode.color : fgcolor;
        bgcolor = outputNode ? outputNode.color : bgcolor;
        selected = isSelected;
        const res = origin_drawNodeShape.call(this, node, ctx, size, fgcolor, bgcolor, selected);
        return res;
      };
      app.canvas.drawNodeWidgets = function(node, posY, ctx, active_widget) {
        if (!node.widgets || !node.widgets.length) {
          return 0;
        }
        const width = node.size[0];
        const widgets = node.widgets;
        posY += 2;
        const H = (LiteGraph || window.LiteGraph || window.LGraph).NODE_WIDGET_HEIGHT;
        const show_text = this.ds.scale > 0.5;
        ctx.save();
        ctx.globalAlpha = this.editor_alpha;
        const outline_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_OUTLINE_COLOR;
        let background_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_BGCOLOR;
        const text_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_TEXT_COLOR;
        const secondary_text_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_SECONDARY_TEXT_COLOR;
        const margin = 15;
        for (let i = 0; i < widgets.length; ++i) {
          const w = widgets[i];
          const inputNode = paramsNodes.find(
            (item) => item.id === node.id && item.category === "input"
          );
          if (inputNode) {
            background_color = inputNode.color;
          } else {
            const current = paramsNodes.find(
              (item) => item.id === node.id && item.selectedWidget.name === w.name
            );
            if (current) {
              background_color = current.color;
            } else {
              background_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_BGCOLOR;
            }
          }
          let y = posY;
          if (w.y) {
            y = w.y;
          }
          w.last_y = y;
          ctx.strokeStyle = outline_color;
          ctx.fillStyle = "#222";
          ctx.textAlign = "left";
          if (w.disabled) ctx.globalAlpha *= 0.5;
          const widget_width = w.width || width;
          switch (w.type) {
            case "button":
              ctx.fillStyle = background_color;
              if (w.clicked) {
                ctx.fillStyle = "#AAA";
                w.clicked = false;
                this.dirty_canvas = true;
              }
              ctx.fillRect(margin, y, widget_width - margin * 2, H);
              if (show_text && !w.disabled) ctx.strokeRect(margin, y, widget_width - margin * 2, H);
              if (show_text) {
                ctx.textAlign = "center";
                ctx.fillStyle = text_color;
                ctx.fillText(w.label || w.name, widget_width * 0.5, y + H * 0.7);
              }
              break;
            case "toggle":
              ctx.textAlign = "left";
              ctx.strokeStyle = outline_color;
              ctx.fillStyle = background_color;
              ctx.beginPath();
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
              else ctx.rect(margin, y, widget_width - margin * 2, H);
              ctx.fill();
              if (show_text && !w.disabled) ctx.stroke();
              ctx.fillStyle = w.value ? "#89A" : "#333";
              ctx.beginPath();
              ctx.arc(widget_width - margin * 2, y + H * 0.5, H * 0.36, 0, Math.PI * 2);
              ctx.fill();
              if (show_text) {
                ctx.fillStyle = secondary_text_color;
                const label = w.label || w.name;
                if (label != null) {
                  ctx.fillText(label, margin * 2, y + H * 0.7);
                }
                ctx.fillStyle = w.value ? text_color : secondary_text_color;
                ctx.textAlign = "right";
                ctx.fillText(
                  w.value ? w.options.on || "true" : w.options.off || "false",
                  widget_width - 40,
                  y + H * 0.7
                );
              }
              break;
            case "slider": {
              ctx.fillStyle = background_color;
              ctx.fillRect(margin, y, widget_width - margin * 2, H);
              const range = w.options.max - w.options.min;
              let nvalue = (w.value - w.options.min) / range;
              if (nvalue < 0) nvalue = 0;
              if (nvalue > 1) nvalue = 1;
              ctx.fillStyle = Object.prototype.hasOwnProperty.call(w.options, "slider_color") ? w.options.slider_color : active_widget === w ? "#89A" : "#678";
              ctx.fillRect(margin, y, nvalue * (widget_width - margin * 2), H);
              if (show_text && !w.disabled) ctx.strokeRect(margin, y, widget_width - margin * 2, H);
              if (w.marker) {
                let marker_nvalue = (w.marker - w.options.min) / range;
                if (marker_nvalue < 0) marker_nvalue = 0;
                if (marker_nvalue > 1) marker_nvalue = 1;
                ctx.fillStyle = Object.prototype.hasOwnProperty.call(w.options, "marker_color") ? w.options.marker_color : "#AA9";
                ctx.fillRect(margin + marker_nvalue * (widget_width - margin * 2), y, 2, H);
              }
              if (show_text) {
                ctx.textAlign = "center";
                ctx.fillStyle = text_color;
                ctx.fillText(
                  w.label || `${w.name}  ${Number(w.value).toFixed(
                    w.options.precision != null ? w.options.precision : 3
                  )}`,
                  widget_width * 0.5,
                  y + H * 0.7
                );
              }
              break;
            }
            case "number":
            case "combo":
              ctx.textAlign = "left";
              ctx.strokeStyle = outline_color;
              ctx.fillStyle = background_color;
              ctx.beginPath();
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
              else ctx.rect(margin, y, widget_width - margin * 2, H);
              ctx.fill();
              if (show_text) {
                if (!w.disabled) ctx.stroke();
                ctx.fillStyle = text_color;
                if (!w.disabled) {
                  ctx.beginPath();
                  ctx.moveTo(margin + 16, y + 5);
                  ctx.lineTo(margin + 6, y + H * 0.5);
                  ctx.lineTo(margin + 16, y + H - 5);
                  ctx.fill();
                  ctx.beginPath();
                  ctx.moveTo(widget_width - margin - 16, y + 5);
                  ctx.lineTo(widget_width - margin - 6, y + H * 0.5);
                  ctx.lineTo(widget_width - margin - 16, y + H - 5);
                  ctx.fill();
                }
                ctx.fillStyle = secondary_text_color;
                ctx.fillText(w.label || w.name, margin * 2 + 5, y + H * 0.7);
                ctx.fillStyle = text_color;
                ctx.textAlign = "right";
                if (w.type === "number") {
                  ctx.fillText(
                    Number(w.value).toFixed(
                      w.options.precision !== void 0 ? w.options.precision : 3
                    ),
                    widget_width - margin * 2 - 20,
                    y + H * 0.7
                  );
                } else {
                  let v = w.value;
                  if (w.options.values) {
                    let values = w.options.values;
                    if (values.constructor === Function) values = values();
                    if (values && values.constructor !== Array) v = values[w.value];
                  }
                  ctx.fillText(v, widget_width - margin * 2 - 20, y + H * 0.7);
                }
              }
              break;
            case "customtext":
              w.element.style.background = background_color;
              if (w.draw) {
                w.draw(ctx, node, widget_width, y, H);
              }
              break;
            case "string":
            case "text":
              ctx.textAlign = "left";
              ctx.strokeStyle = outline_color;
              ctx.fillStyle = background_color;
              ctx.beginPath();
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
              else ctx.rect(margin, y, widget_width - margin * 2, H);
              ctx.fill();
              if (show_text) {
                if (!w.disabled) ctx.stroke();
                ctx.save();
                ctx.beginPath();
                ctx.rect(margin, y, widget_width - margin * 2, H);
                ctx.clip();
                ctx.fillStyle = secondary_text_color;
                const label = w.label || w.name;
                if (label != null) {
                  ctx.fillText(label, margin * 2, y + H * 0.7);
                }
                ctx.fillStyle = text_color;
                ctx.textAlign = "right";
                ctx.fillText(String(w.value).substr(0, 30), widget_width - margin * 2, y + H * 0.7);
                ctx.restore();
              }
              break;
            default:
              if (w.draw) {
                w.draw(ctx, node, widget_width, y, H);
              }
              break;
          }
          posY += (w.computeSize ? w.computeSize(widget_width)[1] : H) + 4;
          ctx.globalAlpha = this.editor_alpha;
        }
        ctx.restore();
        ctx.textAlign = "left";
      };
      const origin_getNodeMenuOptions = app.canvas.getNodeMenuOptions;
      app.canvas.getNodeMenuOptions = function(...res) {
        const node = res[0];
        const options = origin_getNodeMenuOptions.call(this, ...res);
        options.splice(0, options.length);
        if (node.widgets) {
          const selectedWidgets = node.widgets.filter((widget) => {
            const isSelected2 = paramsNodes.some(
              (item) => item.id === node.id && item.selectedWidget.name === widget.name
            );
            return isSelected2;
          });
          const input = {
            content: `\u63D0\u53D6\u8F93\u5165\u300CPick as input\u300D [${selectedWidgets.length}/${node.widgets.length}]`,
            has_submenu: true,
            submenu: {
              options: node.widgets.map((widget) => {
                const isSelected2 = paramsNodes.some(
                  (item) => item.id === node.id && item.selectedWidget.name === widget.name
                );
                return {
                  content: isSelected2 ? `${widget.name} \u2713` : widget.name,
                  className: isSelected2 ? "selected" : "",
                  callback: () => {
                    if (isSelected2) {
                      paramsNodes = paramsNodes.filter(
                        (item) => item.id !== node.id || item.id === node.id && item.selectedWidget.name !== widget.name
                      );
                    } else {
                      const color = getRandomColor();
                      paramsNodes.push({
                        id: node.id,
                        type: node.type,
                        // needed for getRenderComponent
                        color,
                        category: "input",
                        name: widget.name,
                        selectedWidget: { name: widget.name, type: widget.type },
                        // These will be filled by parent's handleMessage
                        description: "",
                        renderComponent: "",
                        key: ""
                      });
                    }
                    eventBus.send(
                      stringify({
                        eventType: "updateParamsNodes",
                        data: paramsNodes
                      })
                    );
                  }
                };
              })
            }
          };
          options.push(input);
        }
        const isSelected = paramsNodes.some(
          (item) => item.id === node.id && ["output"].includes(item.category)
        );
        const output = {
          content: isSelected ? "\u63D0\u53D6\u4E3A\u8F93\u51FA\u8282\u70B9\u300CPick as output\u300D \u2713" : "\u63D0\u53D6\u4E3A\u8F93\u51FA\u8282\u70B9\u300CPick as output\u300D",
          className: isSelected ? "selected-output" : "",
          has_submenu: false,
          callback: () => {
            if (isSelected) {
              paramsNodes = paramsNodes.filter(
                (item) => item.id !== node.id || item.category !== "output"
              );
            } else {
              const color = getRandomColor();
              paramsNodes.push({
                id: node.id,
                type: node.type,
                // needed for getRenderComponent
                color,
                category: "output",
                name: node.title,
                selectedWidget: { id: node.id },
                // These will be filled by parent's handleMessage
                description: "",
                renderComponent: "",
                key: ""
              });
            }
            eventBus.send(
              stringify({
                eventType: "updateParamsNodes",
                data: paramsNodes
              })
            );
          }
        };
        options.push(output);
        return options;
      };
      app.canvas.getCanvasMenuOptions = () => [];
      app.canvas.centerOnNode = function(node) {
        if (!node) return;
        const parent = this.canvas.parentNode;
        const width = parent.offsetWidth;
        const height = parent.offsetHeight;
        this.ds.offset[0] = -node.pos[0] - node.size[0] * 0.5 + width * 0.5 / this.ds.scale;
        this.ds.offset[1] = -node.pos[1] - node.size[1] * 0.5 + height * 0.5 / this.ds.scale;
        this.setDirty(true, true);
      };
      eventBus.on(async (message) => {
        const msgData = typeof message === "string" ? JSON.parse(message) : message;
        const { eventType, data } = msgData;
        if (eventType === "updateParamsNodes") {
          paramsNodes = data;
          eventBus.send(
            stringify({
              eventType: "updateParamsNodes",
              data: paramsNodes
            })
          );
        }
        if (eventType === "centerOnNode") {
          const node = app.graph.getNodeById(data.id);
          app.canvas.centerOnNode(node);
        }
        if (eventType === "loadGraphData") {
          const workflowName = msgData.name || "ArtifyLab Workflow";
          console.log("[ArtifyInject] Processing loadGraphData, target name:", workflowName);
          isArtifyLoading = true;
          try {
            if (data && typeof data === "object") {
              data.name = workflowName;
              data.extra_data = data.extra_data || {};
              data.extra_data.workflow_name = workflowName;
            }
            let lastLoadError = null;
            for (let attempt = 0; attempt < 4; attempt++) {
              try {
                await app.loadGraphData(data, true, true);
                if (data?.nodes?.length && !app.graph?._nodes?.length) {
                  throw new Error("workflow loaded but no nodes on canvas");
                }
                lastLoadError = null;
                break;
              } catch (err) {
                lastLoadError = err;
                console.warn(
                  `[ArtifyInject] loadGraphData attempt ${attempt + 1} failed:`,
                  err?.message ?? err
                );
                await new Promise((r) => setTimeout(r, 3e3));
              }
            }
            if (lastLoadError) {
              console.warn(
                "[ArtifyInject] loadGraphData failed after retries, canvas may be incomplete:",
                lastLoadError?.message ?? lastLoadError
              );
            }
            colorizeLinks();
            colorizeCanvas();
            if (app.graph) app.graph.name = workflowName;
            app.last_loaded_file = workflowName;
            if (app.ui && app.ui.workflowManager && app.ui.workflowManager.activeWorkflow && (artify_playground || isIframe)) {
              const active = app.ui.workflowManager.activeWorkflow;
              active.name = workflowName;
              if (typeof active.rename === "function") active.rename(workflowName);
              if (typeof app.ui.workflowManager.refresh === "function")
                app.ui.workflowManager.refresh();
            }
          } finally {
            isArtifyLoading = false;
          }
          let namingAttempts = 0;
          const namingInterval = setInterval(() => {
            namingAttempts++;
            const active = app.ui && app.ui.workflowManager ? app.ui.workflowManager.activeWorkflow : null;
            if (active) {
              active.name = workflowName;
              if (typeof active.rename === "function") active.rename(workflowName);
            }
            const manager = app.ui && app.ui.workflowManager ? app.ui.workflowManager : null;
            if (manager && manager.workflows) {
              const target = manager.workflows.find(
                (w) => w.name === workflowName || w.displayName === workflowName
              ) || manager.workflows[0];
              if (target) {
                target.name = workflowName;
                if (target.displayName !== void 0) target.displayName = workflowName;
                if (typeof target.rename === "function") target.rename(workflowName);
                if (manager.activeWorkflow && manager.activeWorkflow.id !== target.id) {
                  console.log("[ArtifyInject] Switching back to target workflow:", workflowName);
                  try {
                    manager.switchToWorkflow(target.id);
                  } catch (e) {
                  }
                }
                manager.workflows.forEach((w) => {
                  if (w.id !== target.id) {
                    try {
                      manager.closeWorkflow(w.id);
                    } catch (e) {
                    }
                  }
                });
              }
              if (typeof manager.refresh === "function") manager.refresh();
            }
            if (app.graph) app.graph.name = workflowName;
            if (namingAttempts >= 10) clearInterval(namingInterval);
          }, 500);
          setTimeout(() => {
            const node = data.nodes && data.nodes[0] ? app.graph.getNodeById(data.nodes[0].id) : null;
            if (node) {
              app.canvas.centerOnNode(node);
            }
            eventBus.send(
              stringify({
                eventType: "loadGraphData"
              })
            );
          });
        }
        if (eventType === "updatePrompt") {
          let res;
          try {
            res = await app.graphToPrompt();
          } catch (err) {
            console.warn("[ArtifyInject] graphToPrompt failed:", err?.message ?? err);
            try {
              const g = app.graph;
              for (const id of Object.keys(g.links || {})) {
                const l = g.links[id];
                const t = l && g.getNodeById(l.target_id);
                if (!t || !t.inputs || l.target_slot >= t.inputs.length) {
                  console.warn("[ArtifyInject] removing dangling link", id);
                  g.removeLink(id);
                }
              }
              res = await app.graphToPrompt();
            } catch (err2) {
              console.warn("[ArtifyInject] graphToPrompt retry failed:", err2?.message ?? err2);
              res = { output: {}, workflow: {} };
            }
          }
          eventBus.send(
            stringify({
              eventType: "updatePrompt",
              data: res
            })
          );
        }
      });
    }
    if (onReady) {
      onReady();
    }
  }

  // src/inject/api_workflow.js
  function getQueryParam(key) {
    const params = new URLSearchParams(window.location.search);
    return params.get(key);
  }
  async function getElectronConfig() {
    let config;
    try {
      config = await window.electronAPI.ArtifyLab.getConfig();
    } catch (_e) {
    }
    return config;
  }
  async function apiRequest(endpoint, options = {}) {
    let baseUrl;
    if (isElectron) {
      const electronConfig = await getElectronConfig();
      baseUrl = electronConfig.server_origin;
    } else if (getQueryParam("server_origin")) {
      baseUrl = getQueryParam("server_origin");
    } else {
      baseUrl = "http://localhost:3000";
    }
    const defaultOptions = {
      headers: {
        "Content-Type": "application/json"
      }
    };
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...defaultOptions,
      ...options
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Request failed" }));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }
    return response.json();
  }
  async function getAppById(appId) {
    const response = await apiRequest(`/api/apps/detail`, {
      method: "post",
      body: JSON.stringify({
        id: appId
      })
    });
    if (response.ok) {
      return response.data;
    }
  }
  async function getConfig() {
    const response = await apiRequest(`/api/config`, {
      method: "post"
    });
    if (response.ok) {
      return response.data;
    }
  }
  async function loadWorkflow() {
    if (artify_inject === "readonly" || isIframe || artify_playground) {
      console.log("[ArtifyInject] loadWorkflow aborted: in playground/readonly mode");
      return;
    }
    if (isArtifyLoading) {
      console.log("[ArtifyInject] loadWorkflow skipped: already loading");
      return;
    }
    const { app } = getComfyUIApp();
    if (!app || !app.loadGraphData) {
      setTimeout(() => loadWorkflow(), 500);
      return;
    }
    const config = await getConfig();
    if (!config || !config.activeAppId) {
      console.warn("[ArtifyInject] No active app found in config");
      return;
    }
    const currentApp = await getAppById(config.activeAppId);
    if (!currentApp) {
      console.warn("[ArtifyInject] Could not fetch current app");
      return;
    }
    const workflowName = currentApp.name || "ArtifyLab Workflow";
    const { workflow } = currentApp.template;
    console.log(`[ArtifyInject] Standalone mode: Loading workflow "${workflowName}"`);
    isArtifyLoading = true;
    try {
      if (workflow && typeof workflow === "object") {
        workflow.name = workflowName;
        workflow.extra_data = workflow.extra_data || {};
        workflow.extra_data.workflow_name = workflowName;
        workflow.extra = workflow.extra || {};
        workflow.extra.workflow_name = workflowName;
      }
      await app.loadGraphData(workflow, true, true);
      colorizeLinks();
      colorizeCanvas();
      if (app.graph) {
        app.graph.name = workflowName;
        if (!app.graph.extra) app.graph.extra = {};
        app.graph.extra.workflow_name = workflowName;
      }
      app.last_loaded_file = workflowName;
      if (app.ui && app.ui.workflowManager && app.ui.workflowManager.activeWorkflow) {
        const active = app.ui.workflowManager.activeWorkflow;
        active.name = workflowName;
        if (active.displayName !== void 0) active.displayName = workflowName;
        if (typeof active.rename === "function") active.rename(workflowName);
        if (typeof app.ui.workflowManager.refresh === "function") app.ui.workflowManager.refresh();
      }
      let standaloneNamingAttempts = 0;
      const standaloneNamingInterval = setInterval(() => {
        standaloneNamingAttempts++;
        const active = app.ui && app.ui.workflowManager ? app.ui.workflowManager.activeWorkflow : null;
        if (active) {
          active.name = workflowName;
          if (active.displayName !== void 0) active.displayName = workflowName;
          if (active.metadata) active.metadata.name = workflowName;
          if (typeof active.rename === "function") active.rename(workflowName);
          if (typeof app.ui.workflowManager.refresh === "function") app.ui.workflowManager.refresh();
          const manager = app.ui && app.ui.workflowManager ? app.ui.workflowManager : null;
          if (manager && manager.workflows) {
            const target = manager.workflows.find(
              (w) => w.name === workflowName || w.displayName === workflowName
            ) || manager.workflows[0];
            if (target) {
              target.name = workflowName;
              if (target.displayName !== void 0) target.displayName = workflowName;
              if (target.metadata) target.metadata.name = workflowName;
              if (typeof target.rename === "function") target.rename(workflowName);
              if (manager.activeWorkflow && manager.activeWorkflow.id !== target.id) {
                try {
                  manager.switchToWorkflow(target.id);
                } catch (e) {
                }
              }
              manager.workflows.forEach((w) => {
                if (w.id !== target.id) {
                  try {
                    manager.closeWorkflow(w.id);
                  } catch (e) {
                  }
                }
              });
            }
            if (typeof manager.refresh === "function") manager.refresh();
          }
        }
        if (app.graph) {
          app.graph.name = workflowName;
          if (!app.graph.extra) app.graph.extra = {};
          app.graph.extra.workflow_name = workflowName;
        }
        app.last_loaded_file = workflowName;
        if (standaloneNamingAttempts >= 20) clearInterval(standaloneNamingInterval);
      }, 500);
    } catch (e) {
      console.error("[ArtifyInject] loadWorkflow failed:", e);
    } finally {
      isArtifyLoading = false;
    }
  }

  // src/inject/context.js
  var artify_inject2 = getQueryParam("artify_inject");
  var isElectron2 = !!window.electronAPI;
  var isIframe2 = (function() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  })();
  var artify_playground2 = getQueryParam("artify_playground") === "true";
  if (artify_inject2 === "readonly" || window.self !== window.top || artify_playground2) {
    try {
      if (window.indexedDB) {
        window.indexedDB.deleteDatabase("comfyui");
      }
      const clearRelatedStorage = (storage) => {
        try {
          const keys = Object.keys(storage);
          keys.forEach((key) => {
            const k = key.toLowerCase();
            if (k.includes("comfy") || k.includes("workflow") || k.includes("graph") || k.includes("workspace") || k.includes("litegraph")) {
              storage.removeItem(key);
            }
          });
        } catch (e) {
        }
      };
      clearRelatedStorage(localStorage);
      clearRelatedStorage(sessionStorage);
      const originalGetItem = window.localStorage.getItem;
      window.localStorage.getItem = function(key) {
        if (key && typeof key === "string") {
          const k = key.toLowerCase();
          if (k.includes("workflowmanager") || k.includes("comfy.app.graph") || k.includes("comfy.lastworkflow") || k.includes("comfy_workflow_states") || k.includes("workspace") || k.includes("workspace_manager") || k.includes("litegraph")) {
            return null;
          }
        }
        return originalGetItem.apply(this, arguments);
      };
      console.log("[ArtifyInject] Deep cleaned ComfyUI session storage and IndexedDB");
    } catch (e) {
    }
  }

  // src/inject/governor.js
  function installSidebarWidthGovernor() {
    const MAX_PCT = 45;
    const RESET_PCT = 20;
    const GUTTER_HOT = 14;
    try {
      if (document.getElementById("artify-sidebar-governor-style")) return;
      const style = document.createElement("style");
      style.id = "artify-sidebar-governor-style";
      style.textContent = `
      .p-splitter-horizontal > .p-splitter-gutter { position: relative; }
      .p-splitter-horizontal > .p-splitter-gutter::before {
        content: ''; position: absolute; top: 0; bottom: 0; left: -${Math.floor(GUTTER_HOT / 2)}px; right: -${Math.floor(GUTTER_HOT / 2)}px;
      }
      .p-splitter-horizontal > .p-splitter-gutter { cursor: col-resize; }
    `;
      document.head.appendChild(style);
    } catch (_e) {
    }
    let patching = false;
    const clampPanel = () => {
      if (patching) return;
      const panel2 = document.querySelector(".p-splitterpanel.side-bar-panel");
      if (!panel2) return;
      const m = /calc\(([\d.]+)%/.exec(panel2.style.flexBasis || "");
      if (m && parseFloat(m[1]) > MAX_PCT) {
        patching = true;
        panel2.style.flexBasis = `calc(${MAX_PCT}% - 4px)`;
        const other = panel2.parentElement ? Array.from(panel2.parentElement.children).find(
          (el) => el !== panel2 && el.classList && el.classList.contains("p-splitterpanel")
        ) : null;
        if (other) other.style.flexBasis = `calc(${100 - MAX_PCT}% - 4px)`;
        patching = false;
      }
    };
    const panel = document.querySelector(".p-splitterpanel.side-bar-panel");
    if (panel && !window.__artifySidebarGovObserver) {
      window.__artifySidebarGovObserver = new MutationObserver(clampPanel);
      window.__artifySidebarGovObserver.observe(panel, { attributes: true, attributeFilter: ["style"] });
    }
    if (!window.__artifySidebarGovDbl) {
      window.__artifySidebarGovDbl = true;
      document.addEventListener(
        "dblclick",
        (e) => {
          const g = e.target && e.target.closest && e.target.closest(".p-splitter-horizontal > .p-splitter-gutter");
          if (!g) return;
          const p = document.querySelector(".p-splitterpanel.side-bar-panel");
          if (!p) return;
          p.style.flexBasis = `calc(${RESET_PCT}% - 4px)`;
          const other = p.parentElement ? Array.from(p.parentElement.children).find(
            (el) => el !== p && el.classList && el.classList.contains("p-splitterpanel")
          ) : null;
          if (other) other.style.flexBasis = `calc(${100 - RESET_PCT}% - 4px)`;
          e.preventDefault();
          e.stopPropagation();
        },
        true
      );
    }
    if (!window.__artifyFabAvoid) {
      window.__artifyFabAvoid = true;
      const FAB_SEL = ".p-buttongroup";
      let rafPending = false;
      const avoid = () => {
        rafPending = false;
        const fab = document.querySelector(FAB_SEL);
        const side = document.querySelector(".p-splitterpanel.side-bar-panel");
        if (!fab || !side) return;
        const f = fab.getBoundingClientRect();
        const s = side.getBoundingClientRect();
        const overlaps = f.left < s.right && f.right > s.left && f.top < s.bottom && f.bottom > s.top;
        if (overlaps) {
          const target = Math.round(s.right + 12);
          if (fab.style.left !== target + "px") {
            fab.style.left = target + "px";
            fab.style.right = "auto";
          }
        } else if (fab.style.left) {
          fab.style.left = "";
          fab.style.right = "";
        }
      };
      const schedule = () => {
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(avoid);
        }
      };
      window.addEventListener("resize", schedule, true);
      document.addEventListener("mousemove", schedule, true);
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(schedule);
        ro.observe(document.querySelector(".p-splitter") || document.body);
      }
      avoid();
    }
  }

  // src/inject/digest.js
  function getWorkflowName() {
    try {
      const w = (window.app || {}).extensionManager?.workflow?.activeWorkflow;
      if (w && w.name) return String(w.name);
    } catch (_e) {
    }
    return "Unsaved Workflow";
  }
  async function buildCanvasDigest() {
    const app = getComfyUIApp().app || window.app;
    const g = app && app.graph;
    const nodes = g && g._nodes ? g._nodes : [];
    const models = [];
    const keyParams = {};
    for (const n of nodes) {
      const type = String(n.type || "");
      const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      if (/CheckpointLoader|UNETLoader|Checkpoint.*Loader/i.test(type) && wv[0]) {
        models.push(String(wv[0]));
      }
      if (/LoraLoader/i.test(type) && wv[0]) {
        models.push("lora:" + String(wv[0]));
      }
      if (type === "KSampler" || type === "KSamplerAdvanced") {
        if (Number.isFinite(wv[0])) keyParams.seed = wv[0];
        if (Number.isFinite(wv[1])) keyParams.steps = wv[1];
        if (Number.isFinite(wv[2])) keyParams.cfg = wv[2];
        if (typeof wv[3] === "string") keyParams.sampler = wv[3];
      }
      if (type === "CLIPTextEncode" && typeof wv[0] === "string" && wv[0].trim()) {
        const arr = keyParams.prompts || (keyParams.prompts = []);
        if (arr.length < 4) arr.push(wv[0].slice(0, 80));
      }
    }
    const queue = { running: 0, pending: 0 };
    try {
      const qr = await fetch("/queue", { cache: "no-store" });
      if (qr.ok) {
        const q = await qr.json();
        queue.running = (q.queue_running || []).length;
        queue.pending = (q.queue_pending || []).length;
      }
    } catch (_e) {
    }
    return {
      seq: ++CANVAS_BRIDGE.digestSeq,
      workflowName: getWorkflowName(),
      nodeCount: nodes.length,
      models,
      keyParams,
      queue,
      ts: Date.now()
    };
  }
  function getChangeTracker() {
    try {
      const wf = window.app?.extensionManager?.workflow;
      const ct = wf?.activeWorkflow?.changeTracker;
      return ct && typeof ct.captureCanvasState === "function" ? ct : null;
    } catch (_e) {
      return null;
    }
  }
  function findNodeById(g, id) {
    const num = Number(id);
    if (g._nodes_by_id && g._nodes_by_id[num] != null) return g._nodes_by_id[num];
    if (g._nodes) return g._nodes.find((n) => String(n.id) === String(id)) || null;
    return null;
  }
  async function applyOneOp(g, op) {
    if (!op || typeof op.type !== "string") return { ok: false, error: "op.type required" };
    switch (op.type) {
      case "setWidget": {
        const node = findNodeById(g, op.nodeId);
        if (!node) return { ok: false, error: `node ${op.nodeId} not found` };
        const name = String(op.widget || "");
        const w = (node.widgets || []).find((x) => x && x.name === name);
        if (!w) {
          return { ok: false, error: `widget ${name} not found on node ${op.nodeId}` };
        }
        const before = w.value;
        w.value = op.value;
        if (typeof w.callback === "function") {
          try {
            w.callback(w.value);
          } catch (_e) {
          }
        }
        if (typeof node.onWidgetChanged === "function") {
          try {
            node.onWidgetChanged(w.value);
          } catch (_e) {
          }
        }
        return { ok: true, nodeId: node.id, widget: name, before, after: w.value };
      }
      case "addNode": {
        const type = String(op.nodeType || "");
        const created = window.LiteGraph.createNode(type);
        if (!created) return { ok: false, error: `node type ${type} not registered` };
        if (Array.isArray(op.widgetsValues)) created.widgets_values = op.widgetsValues;
        created.pos = Array.isArray(op.pos) ? op.pos : [100 + Math.random() * 200, 100 + Math.random() * 200];
        g.add(created);
        return { ok: true, nodeId: created.id, type };
      }
      case "removeNode": {
        const node = findNodeById(g, op.nodeId);
        if (!node) return { ok: false, error: `node ${op.nodeId} not found` };
        g.remove(node);
        return { ok: true, nodeId: op.nodeId };
      }
      case "relink": {
        const from = findNodeById(g, op.fromNodeId);
        const to = findNodeById(g, op.toNodeId);
        if (!from || !to) return { ok: false, error: "relink endpoint node not found" };
        const outIdx = Number(op.fromSlot) || 0;
        const inIdx = Number(op.toSlot) || 0;
        if (!from.outputs || !from.outputs[outIdx]) return { ok: false, error: "from slot missing" };
        if (!to.inputs || !to.inputs[inIdx]) return { ok: false, error: "to slot missing" };
        const out = from.outputs[outIdx];
        from.connect(outIdx, to, inIdx);
        return { ok: true, from: from.id, to: to.id, slot: out.name };
      }
      case "loadWorkflow": {
        const wf = op.workflow;
        if (!wf || typeof wf !== "object" || !wf.nodes) return { ok: false, error: "workflow.nodes required" };
        await window.app.loadGraphData(wf);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown op type ${op.type}` };
    }
  }
  async function applyCanvasOps(ops) {
    const app = getComfyUIApp().app || window.app;
    const g = app && app.graph;
    if (!g) return { ok: false, error: "graph not ready" };
    if (!Array.isArray(ops) || !ops.length) return { ok: false, error: "ops must be non-empty" };
    const results = [];
    let applied = 0;
    let needCheckpoint = false;
    for (const op of ops) {
      if (op && op.type !== "setWidget") needCheckpoint = true;
    }
    if (needCheckpoint) {
      const ct = getChangeTracker();
      if (ct) {
        try {
          ct.captureCanvasState();
        } catch (_e) {
        }
      }
    }
    for (const op of ops) {
      if (applied > 0 && op.type === "loadWorkflow") break;
      let r;
      try {
        r = await applyOneOp(g, op);
      } catch (e) {
        r = { ok: false, error: String(e).slice(0, 120) };
      }
      results.push(r);
      if (r.ok) applied++;
    }
    pushCanvasDigest(true);
    return { ok: applied > 0, applied, results };
  }
  async function saveExpressCheckpoint(reason) {
    const app = getComfyUIApp().app || window.app;
    const api = window.__ARTIFY_LAB_API__;
    if (!app || !api || typeof app.graphToPrompt !== "function") return null;
    try {
      const p = await app.graphToPrompt();
      const res = await fetch(`${api}/api/canvas/checkpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: String(reason || ""),
          workflow: p.workflow ?? p,
          prompt: p.output ?? null
        })
      });
      const j = await res.json();
      return j && j.data ? j.data.checkpointId : null;
    } catch (_e) {
      return null;
    }
  }
  var digestPushing = { value: false };
  async function pushCanvasDigest(force) {
    if (digestPushing.value) return;
    digestPushing.value = true;
    try {
      const digest = await buildCanvasDigest();
      const json = JSON.stringify(digest);
      CANVAS_BRIDGE.lastDigestQueueActive = digest.queue.running + digest.queue.pending > 0;
      if (!force && json === CANVAS_BRIDGE.lastDigestJson) return;
      CANVAS_BRIDGE.lastDigestJson = json;
      if (artifyEmbedWindow) {
        try {
          artifyEmbedWindow.postMessage(JSON.stringify({ type: "artify:canvas-state", state: digest }), "*");
        } catch (_e) {
        }
      }
      const api = window.__ARTIFY_LAB_API__;
      if (api) {
        try {
          void fetch(`${api}/api/canvas/snapshot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: json
          }).catch(() => {
          });
        } catch (_e) {
        }
      }
    } catch (e) {
      console.warn("[ArtifyInject] buildCanvasDigest failed:", e);
    } finally {
      digestPushing.value = false;
    }
  }

  // src/inject/card_bridge.js
  var artifyEmbedWindow2 = null;
  function getEmbedWindow() {
    return artifyEmbedWindow2;
  }
  function setEmbedWindow(w) {
    artifyEmbedWindow2 = w;
  }
  function sendCardsToEmbed(nodes) {
    if (!artifyEmbedWindow2) {
      console.warn("[ArtifyInject] no embed window; card attach skipped");
      return;
    }
    const files = [];
    for (const n of nodes) {
      for (const f of n.properties?.files || []) files.push(f);
    }
    if (!files.length) return;
    artifyEmbedWindow2.postMessage(
      JSON.stringify({ type: "artify:card-attach", files }),
      "*"
    );
  }
  function spawnDisplayCards(files) {
    const app = getCardApp();
    if (!app) {
      console.warn("[ArtifyInject] app not ready; cards dropped");
      return;
    }
    const LiteGraph = window.LiteGraph;
    if (!LiteGraph || !LiteGraph.registered_node_types[ARTIFY_CARD_TYPE]) {
      console.warn("[ArtifyInject] card node type not registered yet");
      return;
    }
    const created = [];
    for (let i = 0; i < files.length; i += 8) {
      const chunk = files.slice(i, i + 8);
      const node = LiteGraph.createNode(ARTIFY_CARD_TYPE, "Artify \u5361\u7247", {});
      if (!node) continue;
      node.properties = { files: chunk };
      app.graph.add(node);
      node.setFiles(chunk);
      created.push(node);
    }
    if (!created.length) return;
    const dpi = Math.max(window.devicePixelRatio || 1, 1);
    const area = app.canvas.ds.visible_area;
    const stepX = 256 + 24;
    const startX = area[0] + area[2] / dpi - created.length * stepX - 24 * 2;
    const top = area[1] + 24;
    const bottomLimit = area[1] + area[3] / dpi - 340;
    let x = startX;
    let y = top;
    for (const node of created) {
      node.pos = [x, y];
      node.size = [256, 340];
      y += 340 + 24;
      if (y > bottomLimit) {
        y = top;
        x += stepX;
      }
    }
    {
      let bx = Infinity;
      let by = Infinity;
      let br = -Infinity;
      let bb = -Infinity;
      for (const n of created) {
        const x2 = +n.pos[0];
        const y2 = +n.pos[1];
        const w = +n.size[0];
        const h = +n.size[1];
        if ([x2, y2, w, h].some((v) => !Number.isFinite(v))) continue;
        bx = Math.min(bx, x2);
        by = Math.min(by, y2);
        br = Math.max(br, x2 + w);
        bb = Math.max(bb, y2 + h);
      }
      if (Number.isFinite(bx)) {
        try {
          app.canvas.ds.fitToBounds([bx, by, br - bx, bb - by]);
        } catch (_e) {
        }
      }
    }
  }
  async function handleArtifyMessage(data) {
    if (data.type === "artify:display-card" && Array.isArray(data.files) && data.files.length) {
      spawnDisplayCards(data.files);
    }
    if (data.type === "artify:get-canvas-state") {
      pushCanvasDigest();
    }
    if (data.type === "artify:canvas-ops") {
      const ackType = "artify:canvas-ops-result";
      try {
        const hasStructural = Array.isArray(data.ops) && data.ops.some((o) => o && o.type !== "setWidget");
        let checkpointId = null;
        if (hasStructural) checkpointId = await saveExpressCheckpoint(String(data.reason || ""));
        const r = await applyCanvasOps(data.ops);
        postToEmbed({ type: ackType, requestId: data.requestId, checkpointId, ...r });
      } catch (e) {
        postToEmbed({ type: ackType, requestId: data.requestId, ok: false, error: String(e).slice(0, 120) });
      }
    }
  }
  function postToEmbed(msg) {
    if (!artifyEmbedWindow2) return;
    try {
      artifyEmbedWindow2.postMessage(JSON.stringify(msg), "*");
    } catch (_e) {
    }
  }
  var CANVAS_BRIDGE = {
    digestSeq: 0,
    // 递增序号：工作台/express 据此判断「变了」
    lastDigestJson: "",
    // 去重：摘要无变化不重发
    pollTimer: null,
    pollDelay: 2e3,
    lastQueueRemaining: 0,
    // status 广播的 queue_remaining
    lastDigestQueueActive: false,
    // 最近一次摘要里队列是否有活
    apiBound: false
  };

  // src/inject/card_node.js
  var ARTIFY_CARD_TYPE = "ArtifyDisplayCard";
  var cardImageCache = /* @__PURE__ */ new Map();
  function artifyViewUrl(f) {
    const p = new URLSearchParams({ filename: f.filename, type: f.type || "output" });
    if (f.subfolder) p.set("subfolder", f.subfolder);
    return "/view?" + p.toString();
  }
  function getCardApp() {
    const app = window.app;
    if (!app || !app.graph) return null;
    return app;
  }
  function registerArtifyCardNode(LiteGraph) {
    if (!LiteGraph || LiteGraph.registered_node_types[ARTIFY_CARD_TYPE]) return;
    const LGBase = window.LGraphNode || LiteGraph.LGraphNode;
    if (!LGBase) {
      console.warn("[ArtifyInject] LGraphNode not found, skip card node registration");
      return;
    }
    class ArtifyDisplayCard extends LGBase {
      constructor(title) {
        super(title);
        this.serialize_widgets = false;
      }
    }
    ArtifyDisplayCard.title = "Artify \u5361\u7247";
    ArtifyDisplayCard.desc = "AI \u5DE5\u4F5C\u53F0\u4EA7\u7269\u9648\u5217\uFF08\u4E0D\u53C2\u4E0E\u6267\u884C\uFF09";
    ArtifyDisplayCard.title_color = "#7c5cff";
    ArtifyDisplayCard.prototype.onConfigure = function() {
      this.size = this.size || [256, 320];
    };
    LiteGraph.registerNodeType(ARTIFY_CARD_TYPE, ArtifyDisplayCard);
    const Proto = ArtifyDisplayCard.prototype;
    Proto.isVirtualNode = true;
    Proto.onAdded = function() {
      this.mode = 2;
      this.setDirtyCanvas(true, true);
    };
    Proto.setFiles = function(files) {
      this.properties = this.properties || {};
      this.properties.files = files;
      this.imgs = [];
      this.size = this.size || [256, 320];
      const app = getCardApp();
      for (const f of files) {
        const img = new Image();
        img.onload = () => {
          if (!this.imgs) this.imgs = [];
          this.imgs.push(img);
          this.setDirtyCanvas(true, true);
          this.onResize && this.onResize(this.size);
        };
        img.onerror = () => {
          console.warn("[ArtifyInject] card image failed:", f.filename);
        };
        img.src = artifyViewUrl(f);
      }
      this.setDirtyCanvas(true, true);
    };
    Proto.onResize = function() {
      if (this.imgs && this.imgs[0] && this.imgs[0].naturalWidth) {
        const img = this.imgs[0];
        const ratio = img.naturalHeight / img.naturalWidth;
        const h = Math.max(160, Math.min(560, 256 * ratio + 64));
        if (Math.abs(this.size[1] - h) > 8) {
          this.size[1] = h;
          this.setDirtyCanvas(true, true);
        }
      }
    };
    Proto.onDrawBackground = function(ctx) {
      if (!this.imgs || !this.imgs.length) {
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(0, 0, this.size[0], this.size[1]);
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "12px sans-serif";
        ctx.fillText("\u2026", 8, 18);
        return;
      }
      const cols = this.imgs.length > 1 ? 2 : 1;
      const rows = Math.ceil(this.imgs.length / cols);
      const gap = 4;
      const cw = (this.size[0] - gap * (cols + 1)) / cols;
      const ch = (this.size[1] - gap * (rows + 1)) / rows;
      for (let i = 0; i < this.imgs.length && i < 8; i++) {
        const img = this.imgs[i];
        const x = gap + i % cols * (cw + gap);
        const y = gap + Math.floor(i / cols) * (ch + gap);
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) continue;
        const s = Math.max(cw / iw, ch / ih);
        const sw = cw / s;
        const sh = ch / s;
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, cw, ch);
      }
    };
    Proto.onDblClick = function() {
      sendCardsToEmbed([this]);
    };
    const origGetNodeMenuOptions = window.LiteGraph && window.LiteGraph.LGraphCanvas ? window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions : null;
    if (origGetNodeMenuOptions) {
      window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
        const options = origGetNodeMenuOptions.call(this, node);
        if (node && node.type === ARTIFY_CARD_TYPE) {
          const cardOptions = [
            {
              content: "\u56DE\u586B\u5230\u5DE5\u4F5C\u53F0",
              callback: () => sendCardsToEmbed([node])
            },
            {
              content: "\u4ECE\u753B\u5E03\u79FB\u9664",
              callback: () => {
                const graph = node.graph || getCardApp() && getCardApp().graph;
                if (graph) graph.remove(node);
              }
            },
            null
            // 分隔线
          ];
          if (options && options.length) {
            options.splice(options.length - 1, 0, ...cardOptions);
          } else {
            return [null, ...cardOptions, null];
          }
        }
        return options;
      };
    }
  }

  // src/inject/bridge_events.js
  function bindComfyApiEvents() {
    const api = (window.app || {}).api;
    if (!api || typeof api.addEventListener !== "function" || CANVAS_BRIDGE.apiBound) return;
    CANVAS_BRIDGE.apiBound = true;
    const onExecEvent = () => pushCanvasDigest();
    for (const ev of ["execution_start", "executing", "execution_error", "execution_success", "execution_cached", "progress"]) {
      try {
        api.addEventListener(ev, onExecEvent);
      } catch (_e) {
      }
    }
    try {
      api.addEventListener("status", (ev) => {
        const detail = ev && ev.detail;
        const remaining = detail && (detail.queue_remaining ?? detail.exec_info?.queue_remaining);
        if (typeof remaining === "number") {
          CANVAS_BRIDGE.lastQueueRemaining = remaining;
        }
        pushCanvasDigest();
      });
    } catch (_e) {
    }
    let pending = false;
    api.addEventListener("progress", () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        pushCanvasDigest();
      }, 300);
    });
  }
  function startCanvasPoll() {
    if (CANVAS_BRIDGE.pollTimer) return;
    CANVAS_BRIDGE.pollTimer = setInterval(() => {
      const active = (CANVAS_BRIDGE.lastQueueRemaining || 0) > 0 || CANVAS_BRIDGE.lastDigestQueueActive === true;
      pushCanvasDigest();
      const wantDelay = active ? 400 : 2e3;
      if (wantDelay !== CANVAS_BRIDGE.pollDelay) {
        clearInterval(CANVAS_BRIDGE.pollTimer);
        CANVAS_BRIDGE.pollDelay = wantDelay;
        CANVAS_BRIDGE.pollTimer = null;
        startCanvasPoll();
      }
    }, CANVAS_BRIDGE.pollDelay || 2e3);
  }

  // src/inject/sidebar_tab.js
  function ensureArtifySidebarTab() {
    const app = window.app;
    if (!app || !app.extensionManager || typeof app.extensionManager.registerSidebarTab !== "function") {
      setTimeout(ensureArtifySidebarTab, 1500);
      return;
    }
    installSidebarWidthGovernor();
    try {
      const { LiteGraph: lg } = getComfyUIApp();
      if (lg) registerArtifyCardNode(lg);
    } catch (e) {
      console.warn("[ArtifyInject] register ArtifyDisplayCard failed:", e);
    }
    bindComfyApiEvents();
    startCanvasPoll();
    pushCanvasDigest(true);
    if (typeof app.extensionManager.getSidebarTabs === "function") {
      const existing = app.extensionManager.getSidebarTabs().some((t) => t && t.id === "artify-workbench");
      if (existing) return;
    }
    window.addEventListener("message", (event) => {
      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (_e) {
          return;
        }
      }
      if (data && typeof data.type === "string" && data.type.startsWith("artify:")) {
        if (event.source) setEmbedWindow(event.source);
        handleArtifyMessage(data);
      }
    });
    try {
      app.extensionManager.registerSidebarTab({
        id: "artify-workbench",
        title: "AI \u5DE5\u4F5C\u53F0",
        tooltip: "AI \u5DE5\u4F5C\u53F0",
        icon: "pi pi-sparkles",
        type: "custom",
        render: (container) => {
          container.style.height = "100%";
          container.innerHTML = "";
          const iframe = document.createElement("iframe");
          iframe.id = "artify-workbench-embed";
          iframe.style.cssText = "width:100%;height:100%;border:0;background:transparent;display:block";
          iframe.setAttribute("allow", "clipboard-write");
          const base = window.__ARTIFY_LAB_URL__ || getQueryParam("artify_lab_url") || "";
          const api = window.__ARTIFY_LAB_API__ || base;
          iframe.src = base ? `${base}/workbench?embed=1&server_origin=${encodeURIComponent(api)}` : `/workbench?embed=1`;
          setEmbedWindow(iframe.contentWindow);
          container.appendChild(iframe);
          iframe.addEventListener("load", () => {
            setEmbedWindow(iframe.contentWindow);
            pushCanvasDigest(true);
          });
        }
      });
      console.log("[ArtifyInject] artify workbench sidebar tab registered");
    } catch (e) {
      console.warn("[ArtifyInject] registerSidebarTab failed:", e);
    }
  }
  function startArtifySidebarTab() {
    if (!isIframe2) ensureArtifySidebarTab();
  }

  // src/inject/bootstrap.js
  function installBootstrap() {
    window.addEventListener("load", function() {
      let timer = null;
      if (artify_inject2 === "readonly") {
        let hideReadonlyUI = function() {
          const selectors = [
            ".comfyui-body-top",
            ".comfyui-body-left",
            ".comfyui-body-right",
            ".comfyui-body-bottom",
            ".workflow-tabs-container",
            ".workflow-tabs-container-desktop",
            ".side-tool-bar-container",
            ".floating-sidebar",
            ".connected-sidebar",
            ".comfy-menu-button-wrapper",
            ".comfy-command-menu",
            ".selection-toolbox",
            "rgthree-progress-bar"
          ];
          selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => {
              el.style.display = "none";
            });
          });
        };
        loadCssCode(
          `/* Hide main UI containers - use !important to override inline styles */
      body.litegraph .comfyui-body-top,
      body.litegraph .comfyui-body-left,
      body.litegraph .comfyui-body-right,
      body.litegraph .comfyui-body-bottom,
      body.litegraph .workflow-tabs-container,
      body.litegraph .workflow-tabs-container-desktop {
        display: none !important;
      }

      /* Hide side toolbars */
      body.litegraph .side-tool-bar-container,
      body.litegraph .floating-sidebar,
      body.litegraph .connected-sidebar {
        display: none !important;
      }

      /* Hide menu related elements */
      body.litegraph .comfy-menu-button-wrapper,
      body.litegraph .comfy-command-menu {
        display: none !important;
      }

      /* Hide selection toolbox */
      body.litegraph .selection-toolbox {
        display: none !important;
      }

      /* Hide rgthree and other extension elements */
      body.litegraph rgthree-progress-bar,
      body.litegraph .pysssss-image-feed {
        display: none !important;
      }
    `,
          window
        );
        hideReadonlyUI();
        setTimeout(hideReadonlyUI, 100);
        setTimeout(hideReadonlyUI, 500);
        setTimeout(hideReadonlyUI, 1e3);
      }
      let counter = 0;
      let lastNodeTypesCount = -1;
      let stableNodeTypesCount = 0;
      function checkComfyUIReady() {
        counter++;
        clearTimeout(timer);
        if (counter > 600) {
          console.warn("[ArtifyInject] Timeout waiting for ComfyUI");
          return;
        }
        const vueApp = document.querySelector("#vue-app");
        const hasVueApp = vueApp && vueApp.childNodes.length > 0;
        const hasVersion = typeof window.__COMFYUI_FRONTEND_VERSION__ !== "undefined";
        const hasLiteGraph = !!window.LiteGraph;
        const nodeTypesCount = hasLiteGraph ? Object.keys(window.LiteGraph.registered_node_types || {}).length : 0;
        if (nodeTypesCount > 0 && nodeTypesCount === lastNodeTypesCount) {
          stableNodeTypesCount++;
        } else {
          stableNodeTypesCount = 0;
          lastNodeTypesCount = nodeTypesCount;
        }
        const isFullyReady = hasVersion && hasLiteGraph && stableNodeTypesCount >= 5;
        if (isFullyReady && window.app && window.app.graph) {
          if (artify_inject2 === "readonly" || isIframe2 || artify_playground2) {
            console.log(
              `[ArtifyInject] Playground mode detected (Node types: ${nodeTypesCount}), waiting for stability...`
            );
            setTimeout(() => {
              handleComfyuiContext(() => {
                const message = JSON.stringify({ eventType: "onload" });
                window.parent.postMessage(message, "*");
              });
            }, 2500);
          } else {
            handleComfyuiContext(() => {
              console.log("[ArtifyInject] Standalone mode detected, loading default workflow");
              loadWorkflow();
              window.__artifyReloadWorkflow = () => {
                console.log("[ArtifyInject] Reload workflow requested by desktop");
                loadWorkflow();
              };
            });
          }
          return;
        }
        timer = setTimeout(checkComfyUIReady, 100);
      }
      checkComfyUIReady();
    });
    startArtifySidebarTab();
  }

  // src/inject/modules.js
  var registry = {
    uuidv4,
    getRandomColor,
    colorizeLinks,
    colorizeCanvas,
    getComfyUIApp,
    handleComfyuiContext,
    loadCssCode,
    getElectronConfig,
    apiRequest,
    getConfig,
    loadWorkflow,
    getQueryParam,
    ARTIFY_CARD_TYPE,
    cardImageCache,
    artifyViewUrl,
    getCardApp,
    registerArtifyCardNode,
    CANVAS_BRIDGE,
    sendCardsToEmbed,
    spawnDisplayCards,
    handleArtifyMessage,
    postToEmbed,
    getEmbedWindow,
    setEmbedWindow,
    getWorkflowName,
    buildCanvasDigest,
    getChangeTracker,
    findNodeById,
    applyOneOp,
    applyCanvasOps,
    saveExpressCheckpoint,
    pushCanvasDigest,
    bindComfyApiEvents,
    startCanvasPoll,
    installSidebarWidthGovernor,
    ensureArtifySidebarTab
  };
  function initModules() {
    window.__artifyInjectRegistry = registry;
    return registry;
  }

  // src/inject/index.js
  (function() {
    if (window.__artifyInjectLoaded) {
      return;
    }
    window.__artifyInjectLoaded = true;
    installBootstrap();
    initModules();
  })();
})();