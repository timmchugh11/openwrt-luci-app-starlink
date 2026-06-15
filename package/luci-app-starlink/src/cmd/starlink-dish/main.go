package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	device "github.com/clarkzjw/starlink-grpc-golang/pkg/spacex.com/api/device"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var version = "dev"

type config struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Timeout int    `json:"timeout"`
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage:
  starlink-dish [--host 192.168.100.1] [--port 9200] [--timeout 8] config
  starlink-dish [options] status
  starlink-dish [options] diagnostics
  starlink-dish [options] history
  starlink-dish [options] obstruction-map
  starlink-dish [options] alignment
  starlink-dish [options] dump
  starlink-dish [options] reboot
  starlink-dish [options] stow
  starlink-dish [options] unstow

Options override /etc/config/starlink.
`)
}

func main() {
	cfg := loadConfig()

	flag.StringVar(&cfg.Host, "host", cfg.Host, "Starlink dish host")
	flag.IntVar(&cfg.Port, "port", cfg.Port, "Starlink dish gRPC port")
	flag.IntVar(&cfg.Timeout, "timeout", cfg.Timeout, "request timeout in seconds")
	flag.Usage = usage
	flag.Parse()

	cmd := flag.Arg(0)
	if cmd == "" || cmd == "help" || cmd == "-h" || cmd == "--help" {
		usage()
		return
	}

	if cmd == "config" {
		writeJSON(cfg)
		return
	}

	if err := run(cmd, cfg); err != nil {
		writeJSON(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}

func loadConfig() config {
	cfg := config{Host: "192.168.100.1", Port: 9200, Timeout: 8}
	readUCI("starlink", "main", "host", func(v string) { cfg.Host = v })
	readUCI("starlink", "main", "port", func(v string) {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Port = n
		}
	})
	readUCI("starlink", "main", "timeout", func(v string) {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Timeout = n
		}
	})
	return cfg
}

func readUCI(configName, section, option string, apply func(string)) {
	out, err := runCommand("/sbin/uci", "-q", "get", configName+"."+section+"."+option)
	if err != nil {
		out, err = runCommand("uci", "-q", "get", configName+"."+section+"."+option)
	}
	if err == nil {
		if v := strings.TrimSpace(out); v != "" {
			apply(v)
		}
	}
}

func runCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.Output()
	return string(out), err
}

func run(cmd string, cfg config) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.Timeout)*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(
		ctx,
		fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return fmt.Errorf("connect to dish: %w", err)
	}
	defer conn.Close()

	client := device.NewDeviceClient(conn)

	switch cmd {
	case "status":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_GetStatus{GetStatus: &device.GetStatusRequest{}}})
		if err != nil {
			return err
		}
		return writeProto(resp.GetDishGetStatus())
	case "diagnostics":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_GetDiagnostics{GetDiagnostics: &device.GetDiagnosticsRequest{}}})
		if err != nil {
			return err
		}
		return writeProto(resp.GetDishGetDiagnostics())
	case "history":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_GetHistory{GetHistory: &device.GetHistoryRequest{}}})
		if err != nil {
			return err
		}
		return writeProto(resp.GetDishGetHistory())
	case "obstruction-map":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_DishGetObstructionMap{DishGetObstructionMap: &device.DishGetObstructionMapRequest{}}})
		if err != nil {
			return err
		}
		return writeProto(resp.GetDishGetObstructionMap())
	case "alignment":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_GetDiagnostics{GetDiagnostics: &device.GetDiagnosticsRequest{}}})
		if err != nil {
			return err
		}
		diag := resp.GetDishGetDiagnostics()
		if diag == nil || diag.GetAlignmentStats() == nil {
			return errors.New("alignment stats not available")
		}
		return writeProto(diag.GetAlignmentStats())
	case "dump":
		return dump(ctx, client)
	case "reboot":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_Reboot{Reboot: &device.RebootRequest{}}})
		if err != nil {
			return err
		}
		return writeProto(resp)
	case "stow":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_DishStow{DishStow: &device.DishStowRequest{Unstow: false}}})
		if err != nil {
			return err
		}
		return writeProto(resp)
	case "unstow":
		resp, err := handle(ctx, client, &device.Request{Request: &device.Request_DishStow{DishStow: &device.DishStowRequest{Unstow: true}}})
		if err != nil {
			return err
		}
		return writeProto(resp)
	default:
		return fmt.Errorf("unknown command: %s", cmd)
	}
}

func handle(ctx context.Context, client device.DeviceClient, req *device.Request) (*device.Response, error) {
	resp, err := client.Handle(ctx, req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func dump(ctx context.Context, client device.DeviceClient) error {
	type call struct {
		Name string
		Req  *device.Request
	}

	calls := []call{
		{"status", &device.Request{Request: &device.Request_GetStatus{GetStatus: &device.GetStatusRequest{}}}},
		{"diagnostics", &device.Request{Request: &device.Request_GetDiagnostics{GetDiagnostics: &device.GetDiagnosticsRequest{}}}},
		{"history", &device.Request{Request: &device.Request_GetHistory{GetHistory: &device.GetHistoryRequest{}}}},
		{"obstructionMap", &device.Request{Request: &device.Request_DishGetObstructionMap{DishGetObstructionMap: &device.DishGetObstructionMapRequest{}}}},
		{"deviceInfo", &device.Request{Request: &device.Request_GetDeviceInfo{GetDeviceInfo: &device.GetDeviceInfoRequest{}}}},
		{"networkInterfaces", &device.Request{Request: &device.Request_GetNetworkInterfaces{GetNetworkInterfaces: &device.GetNetworkInterfacesRequest{}}}},
	}

	out := map[string]json.RawMessage{}
	for _, c := range calls {
		resp, err := handle(ctx, client, c.Req)
		if err != nil {
			raw, _ := json.Marshal(map[string]string{"error": err.Error()})
			out[c.Name] = raw
			continue
		}
		raw, err := marshalProto(resp)
		if err != nil {
			raw, _ = json.Marshal(map[string]string{"error": err.Error()})
		}
		out[c.Name] = raw
	}

	writeJSON(out)
	return nil
}

func writeProto(msg proto.Message) error {
	if msg == nil {
		writeJSON(map[string]string{"error": "empty response"})
		return nil
	}
	raw, err := marshalProto(msg)
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}

func marshalProto(msg proto.Message) ([]byte, error) {
	return protojson.MarshalOptions{
		EmitUnpopulated: false,
		UseProtoNames:   false,
		Indent:          "  ",
	}.Marshal(msg)
}

func writeJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
